# Backend — Nasik Property Deals

Express + MySQL API. Also serves the built React frontend in production (single cPanel app).

## Quick start

```bash
npm install
cp .env.example .env       # fill in DB_*, JWT_*, SMTP_*, CORS_ORIGIN
mysql -u root -p -e "CREATE DATABASE IF NOT EXISTS nashik_property_deals CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
npm run migrate
npm run dev                # nodemon on PORT (default 4000)
```

Health check: `GET /api/health`.

## Layout

```
Backend/
├── app.js                  # Passenger entry; Express app
├── server/
│   ├── routes/             # HTTP routing only
│   ├── controllers/        # (to be added) request → service orchestration
│   ├── services/           # (to be added) business logic; email/transporter.js lives here
│   ├── db/                 # MySQL pool, query helpers
│   └── middleware/         # errors, auth
├── migrations/             # numbered .sql files
├── scripts/migrate.js      # runs unapplied migrations in order
├── uploads/
│   ├── public/             # served via /uploads/public/*
│   └── private/            # streamed only through authenticated handlers
└── public/                 # populated from Frontend/dist before deploy
```

## Conventions

- Every SQL query uses parameterized placeholders. No string-concatenated SQL.
- Errors flow through `server/middleware/errors.js`. Throw `HttpError(status, code, message)`; never expose stack traces in responses.
- All email goes through `server/services/email/transporter.js` (single shared `nodemailer` SMTP transporter).
- Scheduled work runs via cPanel cron hitting an endpoint — never `setInterval` (Passenger recycles the process).

## Env keys (see `.env.example`)

| Group | Keys |
|-------|------|
| Server | `NODE_ENV`, `PORT`, `CORS_ORIGIN` |
| DB | `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`, `DB_CONNECTION_LIMIT` |
| Auth | `JWT_ACCESS_SECRET`, `JWT_ACCESS_TTL`, `JWT_REFRESH_SECRET`, `JWT_REFRESH_TTL` |
| SMTP | `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`, `ADMIN_NOTIFICATION_EMAIL` |
| Uploads | `UPLOAD_PUBLIC_DIR`, `UPLOAD_PRIVATE_DIR`, `UPLOAD_MAX_FILE_BYTES`, `UPLOAD_TOTAL_QUOTA_BYTES` |
| OTP | `OTP_TTL_MINUTES`, `OTP_MAX_ATTEMPTS`, `OTP_RATE_PER_MINUTE`, `OTP_RATE_PER_HOUR` |
