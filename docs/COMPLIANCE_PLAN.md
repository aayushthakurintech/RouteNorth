# Compliance work plan

RouteNorth is **not certified** to SOC 2 or ISO 27001, and nothing in the product says it is. This document is the honest starting point: what the product already gives you as evidence, and the order of the work that remains. Settings, Security, Compliance in the app shows the first part live for your organization.

Canadian context worth keeping in mind from day one: PIPEDA, and Quebec's Law 25 (privacy officer, incident register, consent, data residency conversations with customers). GPS history of a named driver is personal information.

## What the product already provides (evidence you can show)

| Need | Where it is in the product |
| --- | --- |
| Tenant isolation | Row-level security on every organization table, tested against a second organization |
| Access control | Roles and permissions; two-factor sign-in (authenticator app and recovery codes); organization-wide "require two-factor"; IP allowlist; session length; session list and sign-out of one device or everyone |
| Audit trail | Append-only audit log of changes and sign-ins, exportable |
| Secrets | Two-factor secrets encrypted before storage; API keys stored as hashes and expire when you set them to |
| Privacy | Retention by days, message retention, tracking only during shifts, person export and erase, organization delete |
| Availability | Public status page and incident history |
| Change record | Release notes inside the app |

## Public legal pages (draft, needs a lawyer)

`/terms`, `/privacy` and `/accessibility` (English and French) are linked from the landing page footer and from sign-up. They describe what the product does today and are marked on the page as a draft for legal review. They cover PIPEDA, Quebec Law 25 (privacy officer, rights including portability, automated-decision notice, incident register), CASL (consent, identification, unsubscribe) and accessibility (WCAG 2.2 AA as a target, with no conformance claim).

Sign-up records the accepted version (`TERMS_VERSION` in `packages/shared/src/legal.ts`), the time and the marketing choice in `signup_consents`. Change the version whenever the text changes in substance.

Before launch the company must supply, through environment variables, the facts only it knows:

| Variable | Used for |
| --- | --- |
| `NEXT_PUBLIC_COMPANY_NAME` | legal name |
| `NEXT_PUBLIC_PRIVACY_EMAIL` | privacy officer contact (Law 25 requires a named person) |
| `NEXT_PUBLIC_SUPPORT_EMAIL` | accessibility feedback |
| `NEXT_PUBLIC_GOVERNING_PROVINCE` | governing law |

Until set, the pages show an obvious placeholder address and province. Also confirm with counsel: hosting region and cross-border transfer wording, the liability cap, consumer-rights wording for Quebec, and the Quebec French text (the French is a careful translation, not a certified legal translation).

Not done: an independent accessibility audit, a Quebec privacy impact assessment for each cross-border provider, and a cookie banner (none is needed while only essential storage is used; add one before adding analytics or advertising).

## What it cannot do for you

- **Encryption at rest and in transit** is provided by your host (disk encryption, TLS at the proxy). Turn both on and write down that you did.
- **Backups** are a script (`docs/OPERATIONS.md`); scheduling, off-site copy and restore tests are yours.
- **Single sign-on** is not built (it is on the public roadmap).
- Policies, staff training, vendor reviews, background checks and an auditor are organizational work, not software.

## Order of work

1. **Months 0 to 2, foundations.** Pick a scope (the production service). Name an owner. Write the short policies: access control, change management, incident response, backup and recovery, acceptable use. Turn on host encryption and scheduled backups, and do the first restore test. Require two-factor for everyone with office access.
2. **Months 2 to 4, evidence.** Keep the audit log export, access reviews (quarterly: who has which role), the restore-test record and the incident register. Run a vulnerability scan and fix what it finds. Choose a compliance automation tool if you want one; it reads the same evidence.
3. **Months 4 to 6, readiness.** A gap assessment against SOC 2 Trust Services Criteria (security first; add availability and confidentiality when customers ask) or ISO 27001 Annex A. Close the gaps. Pen test by a third party.
4. **Months 6 to 12, audit.** SOC 2 Type I, then a Type II observation period of 3 to 12 months. ISO 27001 needs a management system and a two-stage audit; start it if your customers are outside North America.
5. **Ongoing.** Annual policy review, yearly pen test, vendor list review, training.

Ask your auditor which of these they accept as evidence before you spend on tooling.
