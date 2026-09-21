# Amrutam Telemedicine Backend — Architecture & System Design Document

**System Target Scale**: 100,000 daily consultations  
**Target Latency**: p95 < 200ms reads, p95 < 500ms writes  
**Availability SLA**: 99.95% uptime  
**Compliance Standard**: HIPAA, DISHA, OWASP Top 10, ISO 27001 aligned  

---

## 1. High-Level Architecture & Data Flow

Amrutam’s telemedicine platform leverages a high-throughput, horizontally scalable, multi-tier micro-modular architecture. The system is designed to handle bursty consultation traffic during peak morning and evening consultation hours.

### 1.1 Architecture Diagram

```mermaid
flowchart TB
    subgraph Clients["Client Layer"]
        P_App["Patient Web / Mobile App"]
        D_App["Doctor Clinical Portal"]
        A_App["Admin Analytics Dashboard"]
    end

    subgraph Edge["Edge & Security Layer (Cloudflare / Envoy)"]
        WAF["WAF & DDoS Shield"]
        RateLimiter["Distributed Token Bucket Rate Limiter"]
        SSL["TLS 1.3 Termination"]
    end

    subgraph Ingress["Ingress & Gateway"]
        K8s_Ingress["Kubernetes Ingress / ALB"]
        Auth_GW["Auth & Idempotency Interceptor"]
    end

    subgraph AppCluster["Application Tier (Node.js / Express / TypeScript)"]
        direction TB
        API_1["Amrutam Core API (Pod 1)"]
        API_2["Amrutam Core API (Pod 2)"]
        API_N["Amrutam Core API (Pod N - HPA)"]
    end

    subgraph AsyncTier["Asynchronous Processing Tier"]
        Worker_1["Background Worker (BullMQ/Redis)"]
        Worker_2["Prescription PDF & Digital Signature Worker"]
        Worker_3["Notification & SMS/WhatsApp Dispatcher"]
    end

    subgraph DataTier["Data & Cache Tier"]
        subgraph RedisCluster["Redis 7 Cluster"]
            Redis_Lock["Distributed Redlock (Slots)"]
            Redis_Cache["Cache-Aside (Profiles & Search)"]
            Redis_Queue["BullMQ Job Queues"]
        end

        subgraph PostgresCluster["PostgreSQL 16 High-Availability"]
            PG_Primary["Primary (Writes & Strong Reads)"]
            PG_Replica1["Read Replica 1 (Search & Queries)"]
            PG_Replica2["Read Replica 2 (Analytics & Reporting)"]
        end
        
        S3_Store["Object Store (Encrypted Medical Attachments)"]
    end

    subgraph TelemetryTier["Observability & Monitoring"]
        Prom["Prometheus (Metrics Scraper)"]
        Graf["Grafana Dashboards"]
        Jaeger["Jaeger (Distributed Tracing)"]
        Loki["Winston / Loki (Structured JSON Logs)"]
    end

    Clients --> WAF --> RateLimiter --> SSL --> K8s_Ingress --> Auth_GW
    Auth_GW --> API_1 & API_2 & API_N
    API_1 & API_2 & API_N --> RedisCluster
    API_1 & API_2 & API_N --> PG_Primary
    API_1 & API_2 & API_N -.-> PG_Replica1
    Worker_1 & Worker_2 & Worker_3 --> RedisCluster
    Worker_1 & Worker_2 & Worker_3 --> PG_Primary
    Worker_2 --> S3_Store
    PG_Replica2 --> A_App
    
    API_1 & API_2 & Worker_1 -.-> Prom
    API_1 & API_2 & Worker_1 -.-> Jaeger
    API_1 & API_2 & Worker_1 -.-> Loki
    Prom --> Graf
```

### 1.2 Data Flow Lifecycle
1. **Request Ingestion**: Incoming traffic hits Cloudflare/WAF for TLS termination, DDoS mitigation, and global IP rate limiting.
2. **Gateway Interception**:
   - Extract JWT, validate signature, check token revocation cache in Redis.
   - If writing (POST/PUT/PATCH), inspect `Idempotency-Key` header against the Idempotency Store.
3. **Core Processing**:
   - Stateless Node.js microservices execute domain logic via Clean Layered Architecture (Controller -> Service -> Repository).
   - Write operations acquire distributed Redlocks when modifying shared resources (e.g. `availability_slots`).
4. **Data Persistence**:
   - Primary PostgreSQL handles ACID transactions for bookings, payments, and prescription records.
   - Read queries (such as doctor search and directory listing) route to read replicas.
5. **Asynchronous Hand-off**:
   - Heavy tasks (digital signature generation, PDF rendering, email/SMS dispatch, payment settlement verification) are pushed to Redis-backed message queues.
6. **Observability Emission**:
   - Every request is tagged with a unique `X-Correlation-ID` and OpenTelemetry span, exported to Prometheus and Jaeger.

---

## 2. Booking Flow Sequence Diagram

The booking flow must handle high concurrency when multiple patients simultaneously attempt to reserve the same doctor slot. The sequence utilizes distributed locks in Redis coupled with optimistic database locking.

```mermaid
sequenceDiagram
    autonumber
    actor Patient as Patient Client
    participant GW as API Gateway / Ingress
    participant Idem as Idempotency Interceptor
    participant Lock as Redis Distributed Lock (Redlock)
    participant Core as Consultation Service
    participant DB as PostgreSQL (ACID)
    participant Queue as Redis BullMQ (Async)
    participant Notify as Notification Worker

    Patient->>GW: POST /api/v1/consultations/book<br/>Headers: [Idempotency-Key: uuid-1234, Bearer Token]<br/>Body: { doctor_id, slot_id, symptoms }
    GW->>Idem: Check Idempotency-Key (uuid-1234)
    alt Key exists & status = 'COMPLETED'
        Idem-->>Patient: 200 OK (Cached Replay Response)
    else Key exists & status = 'PROCESSING'
        Idem-->>Patient: 409 Conflict ("Transaction currently in progress")
    else Key is new
        Idem->>DB: Record Key (uuid-1234, status='PROCESSING')
    end

    Idem->>Core: Proceed to Reservation
    Core->>Lock: ACQUIRE LOCK (resource: "slot_lock:{slot_id}", ttl: 3000ms)
    alt Lock Acquisition Failed (Slot busy)
        Lock-->>Core: Lock Denied
        Core-->>Patient: 409 Conflict ("Slot is currently being booked by another user")
    else Lock Acquired Successfully
        Lock-->>Core: Lock Granted (Token: lock-xyz)
        
        Core->>DB: BEGIN TRANSACTION
        Core->>DB: SELECT * FROM availability_slots WHERE id = :slot_id FOR UPDATE
        alt Slot status != 'AVAILABLE'
            Core->>DB: ROLLBACK
            Core->>Lock: RELEASE LOCK (Token: lock-xyz)
            Core-->>Patient: 400 Bad Request ("Slot is no longer available")
        else Slot is AVAILABLE
            Core->>DB: UPDATE availability_slots SET status = 'LOCKED', locked_at = NOW(), version = version + 1 WHERE id = :slot_id
            Core->>DB: INSERT INTO consultations (patient_id, doctor_id, slot_id, status='PENDING_PAYMENT')
            Core->>DB: INSERT INTO payments (consultation_id, amount, status='PENDING')
            Core->>DB: COMMIT TRANSACTION
            
            Core->>Lock: RELEASE LOCK (Token: lock-xyz)
            
            Core->>Queue: Enqueue Job ("expire_unpaid_slot", { consultation_id, slot_id }, delay: 900s)
            Core->>Idem: Mark Key COMPLETED + Store Response Payload
            Core-->>Patient: 201 Created { consultation_id, payment_session, expires_in: 900 }
        end
    end

    Note over Patient,Core: Patient completes payment within 15 minutes
    Patient->>GW: POST /api/v1/payments/verify<br/>[Idempotency-Key: pay-9988]
    GW->>Core: Verify & Confirm
    Core->>DB: UPDATE payments SET status = 'SUCCESS'<br/>UPDATE consultations SET status = 'CONFIRMED'<br/>UPDATE availability_slots SET status = 'BOOKED'
    Core->>Queue: Enqueue Notification Event ("send_booking_confirmation")
    Queue->>Notify: Dispatch Email/SMS & Push to Doctor & Patient
    Core-->>Patient: 200 OK { status: 'CONFIRMED', consultation_id }
```

---

## 3. Entity-Relationship (ER) Diagram

```mermaid
erDiagram
    users ||--o| profiles : "has"
    users ||--o| doctors : "extends as doctor"
    doctors ||--o{ availability_slots : "manages"
    users ||--o{ consultations : "books as patient"
    doctors ||--o{ consultations : "conducts as doctor"
    availability_slots ||--o| consultations : "fulfills"
    consultations ||--o| prescriptions : "generates"
    consultations ||--o{ payments : "billed through"
    users ||--o{ audit_logs : "triggers"

    users {
        uuid id PK
        varchar email UK
        varchar password_hash
        varchar role "PATIENT | DOCTOR | ADMIN"
        varchar mfa_secret
        boolean mfa_enabled
        timestamp created_at
        timestamp updated_at
    }

    profiles {
        uuid user_id PK,FK
        varchar first_name
        varchar last_name
        varchar phone
        varchar avatar_url
        date date_of_birth
        varchar gender
    }

    doctors {
        uuid user_id PK,FK
        varchar specialty "AYURVEDA | GENERAL | PANCHAKARMA..."
        integer experience_years
        numeric consultation_fee
        text bio
        numeric rating
        integer total_reviews
        boolean is_verified
        timestamp created_at
    }

    availability_slots {
        uuid id PK
        uuid doctor_id FK
        timestamp start_time
        timestamp end_time
        varchar status "AVAILABLE | LOCKED | BOOKED"
        integer version "Optimistic Locking"
        timestamp locked_at
        timestamp created_at
    }

    consultations {
        uuid id PK
        uuid patient_id FK
        uuid doctor_id FK
        uuid slot_id FK,UK
        varchar status "PENDING_PAYMENT | CONFIRMED | IN_PROGRESS | COMPLETED | CANCELLED"
        text symptoms
        varchar meeting_link
        timestamp created_at
        timestamp updated_at
    }

    prescriptions {
        uuid id PK
        uuid consultation_id FK,UK
        uuid doctor_id FK
        uuid patient_id FK
        text encrypted_medical_notes "AES-256-GCM"
        jsonb medications "Dosage, Herb, Instructions"
        varchar digital_signature "SHA256 Doctor Key Sign"
        timestamp created_at
    }

    payments {
        uuid id PK
        uuid consultation_id FK
        numeric amount
        varchar currency
        varchar status "PENDING | SUCCESS | FAILED | REFUNDED"
        varchar idempotency_key UK
        varchar transaction_ref
        timestamp created_at
    }

    audit_logs {
        uuid id PK
        uuid user_id FK
        varchar action "AUTH_LOGIN | BOOK_SLOT | VIEW_PRESCRIPTION..."
        varchar resource_type
        varchar resource_id
        varchar ip_address
        text user_agent
        varchar payload_hash
        timestamp created_at
    }

    idempotency_keys {
        varchar key PK
        varchar request_hash
        integer response_code
        text response_body
        varchar status "PROCESSING | COMPLETED"
        timestamp expires_at
        timestamp created_at
    }
```

---

## 4. API Schema & Endpoint Architecture

The system provides RESTful JSON APIs structured under `/api/v1`, accompanied by interactive Swagger/OpenAPI documentation at `/api/docs`.

| Method | Endpoint | Description | Auth & Roles | Idempotency |
|---|---|---|---|---|
| `POST` | `/api/v1/auth/register` | Register new user | Public | No |
| `POST` | `/api/v1/auth/login` | User login (returns JWT + MFA status) | Public | No |
| `POST` | `/api/v1/auth/mfa/setup` | Generate TOTP secret & QR code | Bearer (All) | No |
| `POST` | `/api/v1/auth/mfa/verify` | Verify TOTP code and enable MFA | Bearer (All) | No |
| `POST` | `/api/v1/auth/refresh` | Rotate access token via refresh token | Bearer (Refresh) | No |
| `GET` | `/api/v1/doctors` | Search & filter doctors | Public / Cached | No |
| `GET` | `/api/v1/doctors/:id` | Get detailed doctor profile | Public / Cached | No |
| `POST` | `/api/v1/doctors/slots` | Create availability slots | Bearer (Doctor) | Yes |
| `GET` | `/api/v1/doctors/:id/slots` | Get available slots for a doctor | Public / Cached | No |
| `POST` | `/api/v1/consultations/book` | Reserve slot & initiate consultation | Bearer (Patient) | **Required** |
| `POST` | `/api/v1/consultations/:id/cancel` | Cancel booking & trigger refund | Bearer (Patient/Doctor) | **Required** |
| `POST` | `/api/v1/payments/verify` | Simulate payment capture & confirm slot | Bearer (Patient) | **Required** |
| `POST` | `/api/v1/prescriptions` | Issue encrypted prescription | Bearer (Doctor) | **Required** |
| `GET` | `/api/v1/prescriptions/:consultationId` | View decrypted prescription | Bearer (Patient/Doctor)| No |
| `GET` | `/api/v1/admin/analytics` | Consultation metrics, revenue, SLA | Bearer (Admin) | No |
| `GET` | `/api/v1/audit/logs` | Query audit trail for compliance | Bearer (Admin) | No |
| `GET` | `/health/live` | Kubernetes Liveness Probe | Public | No |
| `GET` | `/health/ready` | Kubernetes Readiness Probe (DB/Redis) | Public | No |
| `GET` | `/metrics` | Prometheus Metrics Scrape Endpoint | Internal / Scraper| No |

---

## 5. Retry & Backoff Strategies

To handle transient network hiccups, 3rd-party payment gateway dropouts, and external SMS/Email provider failures, the system applies **Exponential Backoff with Full Jitter**.

### 5.1 Mathematical Model
$$T_{backoff} = \min(T_{max}, T_{base} \times 2^{attempt}) + \text{random}(0, \text{jitter})$$
- $T_{base} = 500\text{ ms}$
- $T_{max} = 30\text{ seconds}$
- Maximum Retries: 5 attempts
- Jitter prevents "thundering herd" spikes against dependent services.

### 5.2 Circuit Breaker Integration
For external payment gateways and notification providers:
- **Closed State**: Normal operations.
- **Open State**: Triggered if error rate exceeds 50% over a 20-second rolling window. Fast fails requests immediately with fallback error.
- **Half-Open State**: After 15 seconds, permits 3 canary probe requests. If successful, resets to Closed; if failing, re-opens.

```mermaid
stateDiagram-v2
    [*] --> Closed
    Closed --> Open : Failure Rate > 50%
    Open --> HalfOpen : Reset Timeout Expired (15s)
    HalfOpen --> Closed : Canary Probes Succeed
    HalfOpen --> Open : Canary Probe Fails
```

---

## 6. Data Partitioning & Scalability Strategy (100k Consultations / Day)

### 6.1 Capacity Sizing Calculation
- 100,000 daily consultations $\approx 3,000,000$ consultations/month $\approx 36,500,000$/year.
- Average consultation record payload: ~2 KB.
- Yearly primary table growth: $\sim 73\text{ GB}$ (metadata) + audit logs ($\sim 250\text{ GB}$).
- Peak throughput: 100,000 consultations over 12 peak hours $\approx 2.3$ bookings/sec average, with burst peaks of $150\text{ bookings/sec}$ during holiday / clinic promotion campaigns.

### 6.2 Partitioning Strategy
1. **Range Partitioning by Month** for high-volume time-series tables:
   - `consultations` partitioned by `created_at` (e.g., `consultations_2026_09`, `consultations_2026_10`).
   - `audit_logs` partitioned by `created_at` monthly. Partitions older than 2 years are archived to cold parquet storage (S3/Glacier) for statutory HIPAA compliance.
2. **Hash Partitioning** for user profiles and slots:
   - Partitioned across 8 shard buckets on `doctor_id` / `patient_id` when scaling beyond 10 million active users.
3. **Read/Write Splitting**:
   - Primary DB handles write transactions.
   - Read replicas handle doctor search, slot viewing, and admin analytics queries with connection pooling (PgBouncer).

---

## 7. Caching and Concurrency Handling

### 7.1 Multi-Tier Caching
1. **L1 Application Cache**: High-frequency configuration, doctor specialization lists (TTL: 1 hour).
2. **L2 Distributed Redis Cache**:
   - `doctor:{id}` profile data (TTL: 15 minutes, Cache-Aside pattern).
   - `search:specialty:{name}` top doctors list (TTL: 5 minutes, invalidated when doctor rating or fee changes).
   - Slot availability: Cached with short TTL (30s) and proactively invalidated upon booking or cancellation.

### 7.2 Concurrency & Double-Booking Elimination
Double booking is prohibited in telemedicine. Two concurrent requests for the same slot are resolved using a **dual-layer protection**:

1. **Redis Redlock (Layer 1 - Edge Protection)**:
   - Atomic acquisition with `SET slot_lock:{slot_id} {uuid} NX PX 3000`.
   - Only 1 worker proceeds; the competing worker immediately receives `409 Conflict`.
2. **PostgreSQL Optimistic Version Check (Layer 2 - Persistence Guard)**:
   ```sql
   UPDATE availability_slots
   SET status = 'LOCKED', version = version + 1, locked_at = NOW()
   WHERE id = $1 AND status = 'AVAILABLE' AND version = $2;
   ```
   If affected rows = 0, transaction aborts, guaranteeing zero race conditions even under network partitions.

---

## 8. Transaction Management & Sagas (Distributed Transactions)

A consultation booking involves cross-boundary actions:
1. Slot lock in Availability Service.
2. Consultation entity creation in Booking Service.
3. Payment pre-authorization in Payment Gateway.
4. Notification dispatch in Communications Service.

We implement an **Orchestration-Based Saga Pattern**:

```mermaid
stateDiagram-v2
    [*] --> SlotLocked : 1. Lock Slot (Timeout 15m)
    SlotLocked --> PaymentInitiated : 2. Generate Payment Intent
    PaymentInitiated --> ConsultationConfirmed : 3. Payment Confirmed (Webhook / Verify)
    PaymentInitiated --> SlotCompensated : 3b. Payment Failed / Expired
    SlotCompensated --> [*] : Slot Released to AVAILABLE
    ConsultationConfirmed --> PrescriptionIssued : 4. Consultation Conducted
    PrescriptionIssued --> Completed : 5. Prescribed & Closed
    Completed --> [*]
    
    ConsultationConfirmed --> RefundCompensated : Cancelled by Doctor/Patient
    RefundCompensated --> [*] : Slot Released + Payment Refunded
```

- **Compensating Actions**:
  - If payment authorization fails: Compensation job releases `availability_slots` back to `AVAILABLE`.
  - If patient cancels 2 hours before slot: Automatic trigger calls payment refund API, marks slot as `AVAILABLE`, and sends cancellation notices.

---

## 9. Backup and Disaster Recovery (DR) Strategy

### 9.1 Recovery Objectives
- **RPO (Recovery Point Objective)**: $< 1\text{ minute}$ (zero data loss for confirmed consultations).
- **RTO (Recovery Time Objective)**: $< 15\text{ minutes}$ for failover to secondary cloud region.

### 9.2 DR Topology & Implementation
- **PostgreSQL Continuous WAL Archiving**:
  - Write-Ahead Logs (WAL) streamed continuously to AWS S3 / GCS multi-region bucket using `pgBackRest` / `WAL-G`.
  - Full snapshots taken daily at 02:00 UTC; differential snapshots taken every 4 hours.
- **Multi-AZ Synchronous Replication**:
  - Standby PostgreSQL replica running in a separate Availability Zone with automated failover via Patroni / AWS RDS Multi-AZ.
- **Redis High Availability**:
  - Redis Sentinel / Redis Cluster with 3 master and 3 replica nodes across 3 availability zones.
- **Drill & Verification**:
  - Bi-weekly automated restoration drill into an isolated staging sandbox verifying database integrity checksums.
