# Amrutam Telemedicine Backend — Security Checklist & Threat Model

This document outlines the security posture, threat modeling (STRIDE), OWASP Top 10 mitigations, data classification, encryption specifications, and key management policies for Amrutam's Telemedicine Platform.

---

## 1. Threat Model & STRIDE Analysis

| STRIDE Category | Threat Scenario | Impact | Mitigation Strategy Implemented |
|---|---|---|---|
| **Spoofing** | Attacker impersonates a doctor or patient using forged JWTs or stolen credentials. | Unauthorized access to confidential medical consultations and prescriptions. | • Short-lived JWTs (15 min) signed with HS256/RS256.<br/>• Mandatory TOTP Multi-Factor Authentication (MFA).<br/>• Token blacklisting in Redis upon logout. |
| **Tampering** | Malicious user alters consultation fee, prescription dosage, or audit log records. | Financial loss, patient health endangerment, legal non-compliance. | • Cryptographic SHA-256 digital signature on all prescriptions.<br/>• Immutable append-only audit logs with SHA-256 payload hashes.<br/>• Strict server-side fee calculations from database. |
| **Repudiation** | Doctor denies issuing a prescription, or patient denies booking a consultation. | Regulatory compliance failure and dispute resolution deadlock. | • Digital signature linking prescription to doctor ID & timestamp.<br/>• IP, User-Agent, and user ID captured in `audit_logs` for every state change. |
| **Information Disclosure** | Leakage of Protected Health Information (PHI) via network eavesdropping or DB leak. | Severe HIPAA / DISHA regulatory penalties and breach of patient trust. | • Field-Level Encryption (FLE) using AES-256-GCM for medical notes.<br/>• Mandatory TLS 1.3 in transit.<br/>• Strict role-based response filtering. |
| **Denial of Service** | Botnet floods booking endpoints, causing slot locking denial or DB connection exhaustion. | Legitimate patients cannot book consultations; service downtime. | • Distributed sliding-window rate limiting via Redis.<br/>• Request timeout limits (10s).<br/>• Cloudflare / WAF DDoS edge filtering. |
| **Elevation of Privilege** | Normal patient invokes doctor slot creation or admin analytics APIs. | Unauthorized system control and data exfiltration. | • Strict Role-Based Access Control (RBAC) middleware verifying roles against authenticated JWT token claims. |

---

## 2. OWASP Top 10 (2021/2025) Mitigations

### A01: Broken Access Control
- **Enforcement**: RBAC middleware intercepts every protected route (`@Roles('DOCTOR')`, `@Roles('ADMIN')`, `@Roles('PATIENT')`).
- **Resource Ownership Check**: Patients can only access their own consultations and prescriptions; doctors can only access consultations assigned to them.
- **CORS & Headers**: Strict CORS origin whitelisting; Helmet security headers applied globally (disabling `X-Powered-By`, enforcing `Content-Security-Policy`, `HSTS`, `X-Frame-Options: DENY`).

### A02: Cryptographic Failures
- **In-Transit**: TLS 1.3 enforced on all API endpoints.
- **At-Rest & Field-Level Encryption**: Sensitive clinical notes in `prescriptions` are encrypted using **AES-256-GCM** with unique Initialization Vectors (IV) and 128-bit authentication tags before persistence.
- **Passwords**: Salted hashing with `bcrypt` (work factor 12) or `argon2id`.

### A03: Injection (SQL, NoSQL, OS Command)
- **Parameterized Queries**: All database interactions use PostgreSQL parameterized queries (`$1`, `$2`), eliminating SQL injection vulnerabilities.
- **Input Validation**: Zod schemas validate and sanitize all incoming headers, params, query strings, and JSON request bodies before reaching controller logic.

### A04: Insecure Design
- **Idempotency Guard**: Atomic idempotency interceptor prevents race-condition exploits, duplicate charges, or double slot reservations.
- **Threat Modeled Flows**: Segregation of clinical data from financial transaction data.

### A05: Security Misconfiguration
- **Secrets Management**: No credentials or API keys stored in code. All configuration injected via environment variables validated at boot.
- **Error Obfuscation**: Production errors adhere to RFC 7807 problem details without leaking stack traces or internal database error messages.

### A06: Vulnerable and Outdated Components
- **Dependency Auditing**: Automated `npm audit` and Trivy vulnerability scanning integrated into GitHub Actions CI pipeline.
- **Minimal Base Images**: Multi-stage Docker build utilizing `node:22-alpine` with non-root runtime user (`node`).

### A07: Identification and Authentication Failures
- **MFA Enforcement**: Time-based One-Time Password (TOTP) supported via RFC 6238 (`otplib`).
- **Brute Force Protection**: Rate limiting on `/api/v1/auth/login` (maximum 5 failed attempts per 5 minutes per IP).

### A08: Software and Data Integrity Failures
- **Prescription Digital Signature**: Each prescription payload is cryptographically hashed with the doctor's signing key. Any database tampering invalidates signature verification.

### A09: Security Logging and Monitoring Failures
- **Audit Trails**: Real-time logging of authentication, slot locking, payment verification, and prescription viewing to an immutable `audit_logs` table.
- **Correlation IDs**: `X-Correlation-ID` header injected into all logs and Prometheus metrics for end-to-end incident investigation.

### A10: Server-Side Request Forgery (SSRF)
- **Outbound Whitelisting**: Any external webhook or notification dispatch is restricted to pre-configured trusted endpoints.

---

## 3. Data Classification & Privacy Matrix

| Data Classification | Fields / Tables | Storage Protection | In-Transit Protection | Access Permissions | Retention Policy |
|---|---|---|---|---|---|
| **PHI (Protected Health Info)** | `prescriptions.encrypted_medical_notes`, `consultations.symptoms` | AES-256-GCM Field-Level Encryption | TLS 1.3 | Doctor of record, Patient owner | 7 years (Statutory medical law) |
| **PII (Personally Identifiable)** | `users.email`, `profiles.phone`, `profiles.first_name`, `profiles.last_name` | Column-level restricted access, hashed indexing | TLS 1.3 | Authenticated user, System Admin | Retained until user deletion request (GDPR/DISHA) |
| **Financial Data** | `payments.amount`, `payments.transaction_ref` | Tokenized, zero raw card data stored (PCI-DSS compliant) | TLS 1.3 | Billing service, Patient owner, Admin | 7 years (Tax compliance) |
| **System & Security Logs** | `audit_logs`, `idempotency_keys` | Append-only, indexed by timestamp and user_id | TLS 1.3 | Security Auditor, Compliance Officer | 2 years online, cold archive thereafter |

---

## 4. Encryption & Key Management Policy

### 4.1 Field-Level Encryption Architecture
For clinical notes and diagnostic impressions:
- **Algorithm**: `AES-256-GCM` (Galois/Counter Mode) providing both confidentiality and data authenticity.
- **IV / Nonce**: 12-byte cryptographically secure pseudo-random number generated per record (`crypto.randomBytes(12)`).
- **Auth Tag**: 16-byte tag verifying that ciphertext has not been altered.
- **Envelope Storage Format**:
  `encrypted_payload = key_id:iv_hex:tag_hex:ciphertext_hex`

### 4.2 Key Rotation Strategy
1. **Master Key**: Stored in AWS KMS / GCP Cloud KMS / HashiCorp Vault.
2. **Key Versioning**: Each ciphertext stores its `key_id` (e.g. `kms-v1`).
3. **Rotation Schedule**:
   - Master keys rotated every 90 days.
   - When decrypting, system looks up key by `key_id`.
   - On key rotation, background worker re-encrypts old records under the latest key version without downtime.
4. **Emergency Revocation**: If a key version is compromised, affected records are quarantined and emergency re-encryption is triggered immediately.

---

## 5. Security Checklist (Pre-Production Sign-Off)

- [x] All database queries use parameterized SQL; zero string concatenation.
- [x] Passwords salted with bcrypt (12 rounds) or argon2id.
- [x] TOTP MFA implemented and tested with standard authenticator apps.
- [x] Rate limiting configured on authentication and booking endpoints.
- [x] Idempotency keys enforced on all write / payment mutations.
- [x] AES-256-GCM field encryption verified for medical notes.
- [x] RBAC policies enforced at router/middleware level.
- [x] Sensitive parameters excluded from application log outputs.
- [x] Helmet security headers active (`X-Frame-Options`, `HSTS`, `CSP`).
- [x] Docker image runs as non-privileged `node` user.
- [x] Automated dependency scan configured in CI pipeline.
