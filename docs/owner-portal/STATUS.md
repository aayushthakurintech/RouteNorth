# Owner Portal: status of every spec item

Source: RouteNorth_Owner_Portal_Spec.pdf (281 numbered items). Generated from the build; each line says what is real.

**How to read this.** *Done* = built and covered by an automated API test and/or a type-checked screen. *Partial* = works, with the gap in the note. *Needs outside account* = built, but cannot work until you add an account or key (not run against the real service). *Not built* = not there.

**Honesty notes.**
- Server behaviour (rules, money, permissions, regions, audit) is covered by API tests. The screens are type-checked, and every owner page was opened in a real browser against the seeded demo (21 pages, no errors, desktop size). Buttons, forms and phone size were not clicked through by hand; that is still for a person to do.
- No email, SMS, Slack, Teams, Twilio, VIN service, or payment provider was called for real.
- Not built at all: SSO, ELD integration, payments, native store apps, push notifications. Not SOC 2 / ISO certified.
- One older test (`smart.test.ts`, driver scoring) depended on the time of day and failed just after local midnight; it is fixed and the full API suite (435 tests) passes.

## Totals

| Status | Items |
|---|---|
| Done | 226 |
| Partial | 48 |
| Needs outside account | 3 |
| Not built | 4 |
| **All** | **281** |

## Choices where the spec was silent

- Money is whole cents in the company currency; dates are UTC and shown in the company time zone.
- Existing data was kept; new columns were added, and nothing is deleted (archive only).
- "Payout waiting" counts pay day as the day after the run's last day.
- Repair budget alert uses one company-wide maintenance budget.
- Automations that send messages are off or skip until an email account exists; pay-day automation is off by default and only drafts.
- Default alert numbers are the ones in the spec table (30/14/7 days, 70 safety, 4.2 rating, 14 days idle driver, etc.), all editable.

## How to use this doc — Rules for the builder

| # | Item | Status | Note |
|---|---|---|---|
| 1 | Build in this order: design system, vehicles, drivers, pay rates, dashboard, reports, alerts. Each module should work before the next one... | Done |  |
| 2 | Follow the design reference in the next section. Do not invent a new style. | Done |  |
| 3 | Every list screen needs search, filters, sort, saved views, bulk actions, and CSV export. | Partial | Search, filters, sort, saved views, bulk bar and CSV/Excel export are on the vehicle, driver, trip, payout, invoice, expense and alert lists. Smaller read-only lists have search and sort only. |
| 4 | Every number on a dashboard or report must click through to the rows behind it. | Partial | Dashboard cards, finance pages and every report open the rows behind the number. A few small summary figures link to the page, not to rows. |
| 5 | Every screen needs a loading state, an empty state, and an error state. | Partial | Every main screen has loading, empty and error states (shared `states.tsx`). Not every small dialog does. |
| 6 | Every change to a vehicle, driver, or pay rate must be saved in the audit log with who, when, old value, and new value. | Done |  |
| 7 | Money is stored as whole cents in a fixed currency per company. Never use floating- point for money. | Done |  |
| 8 | Dates are stored in UTC and shown in the company's time zone. | Done |  |
| 9 | Nothing is deleted for good. Use archive, so old reports still add up. | Done |  |
| 10 | If something here conflicts with what RouteNorth already does, keep the existing data and change the screen, not the data. | Done |  |

## Design reference to follow: shadcn/ui — How to follow it

| # | Item | Status | Note |
|---|---|---|---|
| 1 | Stack: React, Tailwind CSS, Radix UI primitives, TypeScript. Start with npx shadcn@latest init . | Done |  |
| 2 | Colors, radius, and fonts live in CSS variables (design tokens). Light and dark themes switch by changing those variables. | Done |  |
| 3 | Icons: Lucide. Toasts: Sonner. Font: Inter or Geist. | Partial | Lucide icons, Sonner toasts. The app keeps its existing font stack rather than adding Inter or Geist. |
| 4 | Layout: left collapsible sidebar, top bar with search and profile, content in cards. | Done |  |
| 5 | Tables: the shadcn Data Table pattern (TanStack Table) with sorting, filters, column toggle, and pagination. | Done |  |
| 6 | Charts: shadcn Charts (built on Recharts). | Done |  |
| 7 | Search: a command palette opened with Ctrl or Cmd + K. | Done |  |
| 8 | Forms: React Hook Form with Zod checks, using the shadcn Form component. | Partial | React Hook Form + Zod are used by the shadcn Form component and the rate card forms. Vehicle and driver forms use the shared field-kit with the same Zod rules on the server. |
| 9 | Copy the pattern, not just the look: small components, one accent color, lots of white space. | Done |  |

## Owner portal: layout and navigation — Layout rules

| # | Item | Status | Note |
|---|---|---|---|
| 1 | Top bar: global search, date range, company switcher, alerts bell, profile. | Partial | Search, date range, company menu, bell and profile are there. The company menu lists the current company only; switching between several companies is not built (one login = one company). |
| 2 | Breadcrumbs on every detail page. | Done |  |
| 3 | A profile page has a header (photo, name, status, main actions) and tabs below it. | Done |  |
| 4 | Right-side panel (sheet) for quick add and quick edit, so the owner never loses the list. | Done |  |
| 5 | A "saved views" bar above each list (for example: "Cars due for service", "Drivers with expiring license"). | Done |  |
| 6 | Floating bar appears when rows are selected, with bulk actions. | Done |  |
| 7 | Works on phone: sidebar becomes a bottom bar, tables become cards. | Partial | Sidebar becomes a bottom bar on phones. Not checked on a real phone. |
| 8 | Light, dark, and auto themes. Keyboard shortcuts. Command palette. | Partial | Light, dark and auto themes and the Ctrl/Cmd+K palette are done. No wider keyboard-shortcut set. |

## Vehicles — Vehicle list

| # | Item | Status | Note |
|---|---|---|---|
| 1 | Columns: photo, nickname, plate, make and model, year, status, current driver, odometer, next service, insurance expiry, this month's pro... | Done |  |
| 2 | Status labels: Active, On trip, Idle, In service, Out of service, Sold, Archived. | Done |  |
| 3 | Filters: status, type, fuel, driver, location, age, service due, document expiring. | Done |  |
| 4 | Saved views: "Service due in 30 days", "Insurance expiring", "Idle more than 3 days", "Loss-making cars". | Done |  |
| 5 | Bulk actions: assign driver, change status, add a note, export, archive. | Done |  |
| 6 | Grid view with photo cards, and table view. | Done |  |
| 7 | Import cars from CSV with a check-and-fix step. Export to CSV and Excel. | Partial | CSV import with a check step and CSV/Excel export are done. Excel import is not (save as CSV first). |

## Vehicles — Add or edit a vehicle

| # | Item | Status | Note |
|---|---|---|---|
| 1 | Step flow: Basics, Specs, Ownership and cost, Documents, Review. | Partial | Add/edit is a grouped form in a side panel, not a separate step-by-step wizard. |
| 2 | VIN lookup that fills make, model, year, and fuel type. | Needs outside account | VIN decode calls a public vehicle-data service. Needs internet from the API server; not verified against the live service here. |
| 3 | Duplicate check on plate and VIN. | Done |  |
| 4 | Photo upload (front, back, sides, interior) with a main photo. | Partial | Photos upload with a main photo. Labels for front/back/sides/interior are not enforced. |
| 5 | Draft saving, so a half-filled form is not lost. | Done |  |

## Vehicles — Vehicle profile tabs

| # | Item | Status | Note |
|---|---|---|---|
| 1 | Overview. Photo, status, driver, key numbers, quick actions, last 5 events. | Done |  |
| 2 | Specs. Make, model, year, trim, color, VIN, plate, fuel type, engine, seats, cargo size, weight limit, tire size. | Done |  |
| 3 | Ownership and cost. Owned, financed, or leased. Purchase date and price, loan or lease payment, interest rate, end date, residual value, ... | Done |  |
| 4 | Documents. Registration, insurance, inspection, permits, lease papers. Each has a file, issue date, expiry date, and reminder days. | Done |  |
| 5 | Maintenance. Service history, upcoming services, repair log, parts used, shop, cost, invoice photo. | Done |  |
| 6 | Fuel and energy. Fill-ups or charges, litres or kWh, price, station, cost per kilometre, fuel economy trend. | Done |  |
| 7 | Inspections. Daily check results from drivers, failed items, photos, who signed off. | Done |  |
| 8 | Incidents and claims. Accidents, tickets, damage, photos, claim status, repair cost, driver involved. | Done |  |
| 9 | Trips. Every trip this car did, with distance, hours, revenue, and driver. | Done |  |
| 10 | Tracking. Live location, trip replay, geofences, speed events, idle time, engine hours. | Partial | The Tracking tab reuses the existing live tracking, geofence and speed-event features. |
| 11 | Financials. Revenue, fuel, maintenance, insurance, payments, driver pay, profit, cost per kilometre, break-even. | Done |  |
| 12 | Notes and activity. Comments, attachments, and the full change history. | Done |  |

## Vehicles — Maintenance rules

| # | Item | Status | Note |
|---|---|---|---|
| 1 | Service schedules by date, kilometres, or engine hours (whichever comes first). | Done |  |
| 2 | Service templates (oil change, tires, brakes, annual inspection). | Done |  |
| 3 | Reminders at 30, 14, and 7 days before, by email and push. | Partial | Reminders at 30, 14 and 7 days go in-app and by email. Push is not built (no mobile push service). |
| 4 | Auto-block the car from new jobs when a safety check fails or a legal document has expired. | Done |  |
| 5 | Work orders: create, assign to a shop, approve cost, close with invoice. | Done |  |
| 6 | Warranty and recall tracker. | Done |  |
| 7 | Tire and part life tracker. | Done |  |
| 8 | Compare shops by cost and speed. | Done |  |

## Vehicles — Assignment and availability

| # | Item | Status | Note |
|---|---|---|---|
| 1 | Assign a driver to a car for a day, a week, or permanently. | Done |  |
| 2 | Calendar view of which car is with which driver. | Partial | Assignments are shown as a list by car and driver; not a drag-and-drop calendar. |
| 3 | Warn when a driver is not licensed for the car type. | Done |  |
| 4 | Hand-over log: who took the car, when, odometer, fuel level, damage photos. | Partial | Hand-over is logged as an assignment with odometer and notes; fuel level and damage photos are not separate fields. |
| 5 | Booking conflicts shown in red. | Partial | Overlapping bookings are detected by the server; there is no visual timeline of conflicts. |

## Vehicles — Vehicle money view

| # | Item | Status | Note |
|---|---|---|---|
| 1 | Total cost of ownership per car: purchase, finance, fuel, repairs, insurance, tires, tickets. | Done |  |
| 2 | Cost per kilometre and per hour. | Done |  |
| 3 | Profit per car per day, week, month, and lifetime. | Done |  |
| 4 | Break-even date and payback chart. | Partial | Break-even date and payback chart are there; accuracy depends on purchase price and monthly profit being filled in. |
| 5 | "Keep, repair, or sell" score based on repair cost against value. | Done |  |
| 6 | Resale value estimate and sale record when the car is sold. | Partial | Sale record (date, price) is kept when a car is sold. A resale value estimate is not built. |

## Vehicles — Vehicle alerts

| # | Item | Status | Note |
|---|---|---|---|
| 1 | Document expiring or expired. | Done |  |
| 2 | Service due or overdue. | Done |  |
| 3 | Failed inspection. | Done |  |
| 4 | Car idle more than a set number of days. | Done |  |
| 5 | Odometer jump that does not match trips. | Not built | Odometer-jump check is not built. |
| 6 | Fuel use above normal. | Done |  |
| 7 | Car left a geofence or moved outside shift hours. | Partial | Geofence exit uses the existing geofence rules. "Moved outside shift hours" is not built as an alert. |
| 8 | Repair cost this month above budget. | Partial | One company-wide maintenance budget (from the Budget page), not one per car. |

## Pay rates — Rules and extras that change a rate

| # | Item | Status | Note |
|---|---|---|---|
| 1 | Minimum fare and minimum pay per trip. | Done |  |
| 2 | Free waiting time, then a waiting fee per minute. | Done |  |
| 3 | Peak hours, night hours, weekends, and holidays (percent or fixed add-on). | Done |  |
| 4 | Surge or demand multiplier, with a cap the owner sets. | Done |  |
| 5 | Vehicle type (van, truck, electric, premium). | Done |  |
| 6 | Driver level (new, experienced, senior) with different pay. | Done |  |
| 7 | Fuel surcharge that follows the fuel price. | Partial | Fuel surcharge is built from a fuel price the owner enters; it does not fetch live fuel prices. |
| 8 | Toll and parking pass-through, paid back with a receipt. | Done |  |
| 9 | Cancellation and no-show fee. | Done |  |
| 10 | Bad weather add-on. | Partial | Bad weather add-on is applied as a condition on the trip; there is no automatic weather feed. |
| 11 | Long-distance or out-of-zone add-on. | Done |  |
| 12 | Taxes per region (for example HST in Ontario), shown as separate lines. | Done |  |
| 13 | Rounding rule (to the cent, to 5 cents). | Done |  |
| 14 | Currency per company. | Partial | Money is stored in whole cents in one currency per company (the company setting). Multi-currency trips are not built. |

## Pay rates — Rate card management

| # | Item | Status | Note |
|---|---|---|---|
| 1 | Create, clone, and archive rate cards. | Done |  |
| 2 | Each card has a start date and an end date. Old trips always use the card that was active on that day. | Done |  |
| 3 | Draft, Pending approval, Active, and Expired states. Big changes need a second person to approve. | Done |  |
| 4 | Assign a card to a driver, a group of drivers, a vehicle type, a customer, or a zone. Show which card wins when more than one applies. | Done |  |
| 5 | Price simulator. Type a distance, time, and conditions and see the customer price, the driver pay, the car cost, and the margin before sa... | Done |  |
| 6 | Compare two cards side by side, with the change in average trip pay. | Done |  |
| 7 | "What if" report: replay last month's trips with a new card and show the effect on cost and margin. | Done |  |
| 8 | Full version history with who changed what. | Done |  |

## Pay rates — Bonuses and incentives

| # | Item | Status | Note |
|---|---|---|---|
| 1 | Trip count bonus (complete 50 trips this week, get $75). | Done |  |
| 2 | On-time bonus and rating bonus. | Done |  |
| 3 | Peak-hour bonus and busy-zone bonus. | Done |  |
| 4 | Referral bonus. | Partial | Referral bonus is entered by hand (one-time bonus with a reason); drivers do not refer each other in an app yet. |
| 5 | Safety bonus (no incidents for 30 days). | Done |  |
| 6 | Streak bonus and tiered bonus. | Done |  |
| 7 | One-time bonus the owner types in by hand, with a reason. | Done |  |
| 8 | Bonus rules show a progress bar in the driver's view. | Partial | Progress for each bonus rule is computed and shown on the driver's Pay tab in the owner portal. The driver-facing app does not have a pay screen yet. |

## Pay rates — Deductions and adjustments

| # | Item | Status | Note |
|---|---|---|---|
| 1 | Vehicle rental or lease share. | Done |  |
| 2 | Fuel advance or fuel card charges. | Done |  |
| 3 | Fines, tickets, and damage costs, with a photo and a note. | Done |  |
| 4 | Uniform, equipment, and phone fees. | Done |  |
| 5 | Loan or advance paid back in parts. | Done |  |
| 6 | Manual adjustment (plus or minus) with a reason and an approval step. | Done |  |
| 7 | Cap on how much can be taken from one payout. | Done |  |
| 8 | Every deduction is visible to the driver with its reason. | Partial | Every deduction carries its reason and is on the statement. The driver cannot see it in an app yet (no driver pay screen). |

## Pay rates — Payouts

| # | Item | Status | Note |
|---|---|---|---|
| 1 | Pay cycles: daily, weekly, every two weeks, monthly. | Partial | Pay cycles can be chosen and an optional automatic draft on pay day exists (off by default). |
| 2 | A payout run screen: pick the period, review each driver's line items, fix problems, approve, and mark paid. | Done |  |
| 3 | A statement for each driver: trips, rates used, bonuses, deductions, tips, net pay. | Done |  |
| 4 | Payout statuses: Draft, Approved, Sent, Paid, Failed, Disputed. | Done |  |
| 5 | Dispute flow: the driver flags a line, the owner replies, and the fix is logged. | Done |  |
| 6 | Export for payroll or accounting (CSV, Excel, QuickBooks, Xero). | Partial | CSV and Excel are real files. QuickBooks and Xero get a generic CSV in their import column layout; not tested in those products. |
| 7 | Hold a payout for a missing document or an open incident. | Done |  |
| 8 | Year-end summaries for tax time. | Partial | Year-end totals per driver as a table and CSV for the accountant; not a government-format filing. |
| 9 | A setting for whether each driver is an employee or a contractor, so the correct paperwork shows up. Owners should check local labour rules. | Partial | Employee/contractor flag changes which paperwork shows. Legal classification advice is left to the owner. |

## Drivers — Driver list

| # | Item | Status | Note |
|---|---|---|---|
| 1 | Columns: photo, name, phone, status, assigned car, rating, on-time rate, trips this month, earnings this month, license expiry, last active. | Done |  |
| 2 | Status labels: Applicant, Onboarding, Active, On trip, Off duty, Suspended, Archived. | Done |  |
| 3 | Filters: status, car, rate card, region, rating, documents expiring, new this month. | Done |  |
| 4 | Saved views: "Documents expiring", "Low rating", "No trips in 14 days", "Top 10 this month". | Done |  |
| 5 | Bulk actions: message, assign rate card, assign car, change status, export. | Done |  |
| 6 | Invite a driver by email or text link. Import drivers from CSV. | Partial | Invite by email link is done (needs RESEND to actually send). Text-message invites are not sent (needs Twilio). CSV import is done. |

## Drivers — Onboarding flow

| # | Item | Status | Note |
|---|---|---|---|
| 1 | Invite sent, driver signs up, and the owner sees the progress as a checklist. | Done |  |
| 2 | Steps: personal details, license upload, background check, vehicle training, contract signature, bank details, first test trip. | Done |  |
| 3 | Owner approves or rejects each step with a reason. | Done |  |
| 4 | Auto-reminders to drivers who stop halfway. | Partial | Reminders to stalled drivers go through the email automation, which needs an email account to be configured. |
| 5 | Driver cannot receive jobs until the required steps are done. | Done |  |
| 6 | Offboarding checklist: return the car, final payout, remove access, archive. | Done |  |

## Drivers — Driver profile tabs

| # | Item | Status | Note |
|---|---|---|---|
| 1 | Overview. Photo, status, contact, assigned car, rate card, rating, key numbers, quick actions. | Done |  |
| 2 | Personal. Name, phone, email, address, emergency contact, date of birth, languages, home base. | Done |  |
| 3 | Documents. License (class, number, expiry), work permit if needed, background check, medical or training certificates, contract. Each has... | Done |  |
| 4 | Vehicle. Current car, past cars, license class check, hand-over history, damage reports. | Done |  |
| 5 | Schedule. Shifts, availability, time off, and a weekly calendar. Conflicts shown in red. | Done |  |
| 6 | Trips. All trips with distance, duration, revenue, rating, and issues. | Done |  |
| 7 | Performance. Score, on-time rate, acceptance rate, cancellation rate, customer ratings, complaints, trips per hour. | Done |  |
| 8 | Safety. Speeding, harsh braking, harsh turns, phone use, late-night driving, incidents, tickets, safety score trend. | Done |  |
| 9 | Pay. Rate card, bonuses earned, deductions, current period earnings, past payouts, statements, disputes. | Done |  |
| 10 | Bank and tax. Payout method, tax forms, employee or contractor flag. Only owners with the right permission can see this tab. | Done |  |
| 11 | Training. Required courses, completion dates, tests, certificates. | Done |  |
| 12 | Notes and activity. Warnings, praise, private notes, messages, and change history. | Done |  |

## Drivers — Performance and coaching

| # | Item | Status | Note |
|---|---|---|---|
| 1 | A driver score from 0 to 100, with the formula visible (for example: 30% on-time, 25% safety, 25% customer rating, 10% acceptance, 10% cl... | Done |  |
| 2 | Leaderboard by week and month, which the owner can switch on or off. | Done |  |
| 3 | Compare a driver to the team average. | Done |  |
| 4 | Goals per driver and progress bars. | Done |  |
| 5 | Warning and recognition log with dates. | Done |  |
| 6 | Coaching notes and follow-up tasks with due dates. | Done |  |
| 7 | Improvement plan for a driver below a set score. | Done |  |

## Drivers — Hours and compliance

| # | Item | Status | Note |
|---|---|---|---|
| 1 | Shift start and end, breaks, and total hours per day and week. | Done |  |
| 2 | Overtime warnings and the overtime rule for the region. | Done |  |
| 3 | Hours-of-service limits for long-haul or commercial drivers. | Partial | Daily and weekly hours with the overtime rule are checked. Full commercial hours-of-service (cycles, 14-hour window) needs an ELD, which is phase 2. |
| 4 | Rest-time checks between shifts. | Done |  |
| 5 | Block a driver from going on duty when a required document is expired. | Done |  |
| 6 | Compliance score per driver and for the whole company. | Done |  |

## Drivers — Driver money view

| # | Item | Status | Note |
|---|---|---|---|
| 1 | Revenue each driver brings in. | Done |  |
| 2 | Pay cost, fuel cost, and repair cost linked to the driver. | Done |  |
| 3 | Profit per driver, per hour, and per trip. | Done |  |
| 4 | Driver pay history with every line item. | Done |  |
| 5 | Tips earned. | Done |  |
| 6 | Outstanding advances and deductions. | Done |  |
| 7 | Next payout date and the amount. | Done |  |

## Drivers — Driver alerts

| # | Item | Status | Note |
|---|---|---|---|
| 1 | License or document expiring or expired. | Done |  |
| 2 | Safety score dropped. | Done |  |
| 3 | Low rating or a new complaint. | Done |  |
| 4 | Overtime reached. | Done |  |
| 5 | No activity for a set number of days. | Done |  |
| 6 | Very high cancellation rate. | Done |  |
| 7 | Large payout dispute or a pay figure that looks wrong. | Done |  |
| 8 | New driver stuck in onboarding. | Done |  |

## Owner dashboard and money view — Needs-attention panel

| # | Item | Status | Note |
|---|---|---|---|
| 1 | Documents expiring in 14 days (cars and drivers). | Done |  |
| 2 | Services overdue. | Done |  |
| 3 | Payouts waiting for approval. | Done |  |
| 4 | Disputes waiting for a reply. | Done |  |
| 5 | Failed inspections. | Done |  |
| 6 | Drivers stuck in onboarding. | Done |  |
| 7 | Cars or drivers losing money this month. | Done |  |
| 8 | Rate card changes waiting for approval. | Done |  |

## Owner dashboard and money view — Finance pages

| # | Item | Status | Note |
|---|---|---|---|
| 1 | Earnings. Revenue by day, customer, car, driver, route, and zone. | Done |  |
| 2 | Expenses. Fuel, maintenance, insurance, finance payments, tolls, parking, fines, software, and other. Add by hand or import from a bank f... | Done |  |
| 3 | Payouts. All driver payouts and their status. | Done |  |
| 4 | Invoices. Customer invoices and payment status, with overdue reminders. | Done |  |
| 5 | Profit and loss. Revenue minus all costs, by month and by year, with a breakdown. | Done |  |
| 6 | Cash flow. Money expected in and out over the next 30, 60, and 90 days. | Done |  |
| 7 | Budget. Monthly budget per cost type, with progress bars and warnings. | Done |  |
| 8 | Tax summary. Tax collected and paid, ready for the accountant. | Done |  |

## Report builder, scheduling, and export — Report builder

| # | Item | Status | Note |
|---|---|---|---|
| 1 | Pick a data source: vehicles, drivers, trips, pay, payouts, expenses, invoices, customers, maintenance, documents. | Done |  |
| 2 | Pick columns, including calculated ones (for example: profit divided by km). | Done |  |
| 3 | Add filters with AND and OR rules. | Partial | Filters are AND rules. OR groups are not in the builder. |
| 4 | Group by one or two fields, and sort. | Done |  |
| 5 | Choose a chart: table, bar, stacked bar, line, area, pie or donut, scatter, heat map, funnel, waterfall, map. | Partial | Table, bar, stacked bar, line, area, pie/donut, scatter, heat map, funnel, waterfall are drawn. The "map" type is not. |
| 6 | Totals, subtotals, averages, minimum, maximum, and percent of total. | Done |  |
| 7 | Compare with the previous period or the same period last year. | Done |  |
| 8 | Pivot view (rows by columns). | Done |  |
| 9 | Live preview while building. | Done |  |
| 10 | Save as a private report or share with the team. | Done |  |
| 11 | Duplicate any ready-made report and edit the copy. | Done |  |
| 12 | Ask in plain words ("profit per car last quarter") and get a draft report to adjust. | Partial | Plain-words box matches keywords and common phrases to a draft report; it is not a language model. |

## Report builder, scheduling, and export — Using reports

| # | Item | Status | Note |
|---|---|---|---|
| 1 | Click any number to open the rows behind it. | Done |  |
| 2 | Pin a report to the dashboard as a card. | Done |  |
| 3 | Favorites and recent reports. | Done |  |
| 4 | Report folders for the team. | Done |  |
| 5 | Share a private link with an expiry date. | Done |  |
| 6 | Comment on a report and tag a teammate. | Done |  |
| 7 | Version history for saved reports. | Done |  |
| 8 | Permission rules, so a manager only sees the cars and drivers in their region. | Done |  |

## Report builder, scheduling, and export — Scheduling and delivery

| # | Item | Status | Note |
|---|---|---|---|
| 1 | Schedule: daily, weekly, monthly, or on the 1st working day of the month. | Done |  |
| 2 | Send to email, Slack, or Teams. Attach PDF or Excel, or send a link. | Needs outside account | Email needs RESEND_API_KEY and EMAIL_FROM. Slack and Teams need an incoming-webhook URL from the owner. Not run against real accounts. |
| 3 | Send to different people with different filters (each manager gets their own region). | Done |  |
| 4 | "Only send if" rules (for example: only when a document expires within 14 days). | Done |  |
| 5 | Pause, edit, and delivery log with failures shown. | Done |  |
| 6 | Time zone per schedule. | Done |  |

## Report builder, scheduling, and export — Export and sharing

| # | Item | Status | Note |
|---|---|---|---|
| 1 | PDF with the company logo and colors, page numbers, and a date range on the cover. | Partial | PDF export exists with a header, date range and page numbers; logo/brand-colour styling is basic. |
| 2 | Excel with real number formats and formulas where it makes sense. | Partial | Real .xlsx export with number and money formats. Formulas are not written into the cells. |
| 3 | CSV for any table. | Done |  |
| 4 | Google Sheets sync. | Not built | Google Sheets sync is not built (needs a Google account connection). CSV/API give the same data. |
| 5 | API access to every report so other tools can read the numbers. | Done |  |
| 6 | Print view. | Done |  |
| 7 | Export the full company data (vehicles, drivers, trips, pay) in one file. | Done |  |

## Report builder, scheduling, and export — Report quality rules

| # | Item | Status | Note |
|---|---|---|---|
| 1 | Every report shows the date it was last updated and the filters used. | Done |  |
| 2 | Totals on a report must match the totals on the dashboard and the finance pages. | Done |  |
| 3 | Money columns always show the currency. | Done |  |
| 4 | Large reports run in the background and notify the owner when ready. | Partial | Reports run live, capped at 5,000 rows on screen; there is no background run with a "ready" notification. |
| 5 | Empty reports say why they are empty and suggest a wider date range. | Done |  |

## Alerts and automations — How alerts work

| # | Item | Status | Note |
|---|---|---|---|
| 1 | Delivery: in-app bell, email, SMS, push, Slack, and Teams. | Needs outside account | In-app bell is done. Email needs RESEND_API_KEY + EMAIL_FROM; SMS needs Twilio; Slack/Teams need webhook URLs. Push is not built (no mobile push service). |
| 2 | Each person picks what they get and how. | Done |  |
| 3 | Severity levels: Info, Warning, Critical. Critical alerts keep repeating until someone acts. | Done |  |
| 4 | Quiet hours, with Critical alerts allowed through. | Done |  |
| 5 | A daily digest email: "Here is what needs you today". | Done |  |
| 6 | Snooze, assign to a teammate, and mark as done. | Done |  |
| 7 | Alert history with who handled each one. | Done |  |
| 8 | Group repeated alerts, so one expired document is one alert, not ten. | Done |  |
| 9 | The owner can create custom rules in the form "when [measure] [is above/below] [value] for [car, driver, or company], tell [person] by [c... | Done |  |

## Alerts and automations — Automations

| # | Item | Status | Note |
|---|---|---|---|
| 1 | Block a driver or car from new jobs when a required document expires. | Done |  |
| 2 | Create a maintenance work order when a service threshold is reached. | Done |  |
| 3 | Send the driver a reminder 14 days before a document expires. | Partial | Driver reminders at 14 days go out by email, so they need the email account. |
| 4 | Start a payout run on pay day and send it to the owner for approval. | Partial | Off by default. It creates a draft run and tells the owner; it never approves or pays by itself. |
| 5 | Send each driver their statement when a payout is marked paid. | Partial | Statement email has totals and a link; there is no PDF attached. |
| 6 | Email a weekly summary to the owner every Monday morning. | Done |  |
| 7 | Flag a trip for review when pay is far from normal. | Done |  |
| 8 | Add an invoice reminder when a customer is late. | Partial | Reminders are sent once per invoice; sending needs the email account. |
| 9 | Fire a webhook to other tools on any event. | Done |  |

## Roles, permissions, and audit log — Access controls

| # | Item | Status | Note |
|---|---|---|---|
| 1 | Invite people by email and set a role. | Done |  |
| 2 | Limit a person to chosen regions, depots, cars, or drivers. | Partial | Regions are enforced on vehicles, drivers, trips, reports and alerts. Limiting to individual depots, cars or drivers is not built. |
| 3 | Sign-in with Google or Microsoft, and two-factor sign-in for owners, admins, and accountants. | Partial | Two-factor sign-in (authenticator app) exists from the earlier security work. Google/Microsoft sign-in is not built. |
| 4 | Ask for the password again before sensitive actions (change bank details, approve a payout). | Not built | Asking for the password again before sensitive actions is not built. |
| 5 | Session list with "sign out everywhere". | Done |  |
| 6 | Change requests: the first person asks, the owner approves (for example: change a pay rate by more than 10%). | Partial | Rate card changes need a second approver. A general "ask the owner to approve" request flow is not built. |
| 7 | Hide pay figures from a role without removing the rest of the profile. | Done |  |
| 8 | Mask sensitive fields (show only the last 4 digits of a bank account). | Done |  |

## Roles, permissions, and audit log — Audit log

| # | Item | Status | Note |
|---|---|---|---|
| 1 | Every create, edit, archive, export, approval, and sign-in is logged. | Partial | Create, edit, archive, export, approval and status changes in the portal are logged with old/new values. Sign-ins are in the earlier security log. |
| 2 | Each line: time, person, action, item, old value, new value, IP address. | Done |  |
| 3 | Filter by person, item type, action, and date. | Done |  |
| 4 | Cannot be edited or deleted by anyone in the app. | Done |  |
| 5 | Export to CSV. | Done |  |
| 6 | Pay rate changes, payout approvals, and bank detail changes are highlighted. | Done |  |

## Data model — Key links between records

| # | Item | Status | Note |
|---|---|---|---|
| 1 | A company has many vehicles, drivers, rate cards, customers, and users. | Done |  |
| 2 | A vehicle has many documents, maintenance records, fuel entries, inspections, incidents, assignments, and trips. | Done |  |
| 3 | A driver has many documents, shifts, safety events, trips, and payouts, and one active rate card at a time. | Done |  |
| 4 | A trip belongs to one driver and one vehicle, and stores the rate card version used, so old trips never change when a rate card changes. | Done |  |
| 5 | A trip has many pay lines. A payout is the sum of pay lines for one driver in one period. | Done |  |
| 6 | Reports read from these records, and every dashboard number must be built from the same rules as the matching report. | Done |  |
| 7 | Reports should read from a reporting copy of the data (a read replica or summary tables) so heavy reports never slow down the live app. | Not built | Reports read the main database. There is no read replica or summary tables yet. |

## Build order and acceptance checklist — Build order and acceptance checklist

| # | Item | Status | Note |
|---|---|---|---|
| 1 | Foundation shadcn/ui setup, tokens, light and A sample list page looks and dark theme, sidebar layout, behaves like the reference, and co... | Done | Foundation done. |
| 2 | Vehicles List, add and edit, profile tabs, The owner can add a car, attach documents, maintenance, fuel, papers, log a service, and get a... | Done | Vehicles done and tested. |
| 3 | Drivers List, onboarding, profile tabs, The owner can invite a driver, documents, schedule, approve each step, and see their performance,... | Done | Drivers done and tested. |
| 4 | Pay rates Rate cards, rules, simulator, A test trip produces the exact assignment, bonuses, breakdown in the worked deductions, pay lines... | Done | Pay rates done; the worked example produces $55.20 in a test. |
| 5 | Dashboard and Dashboard tabs, needs-attention Dashboard totals match the and loss, margin explorer | Done | Dashboard totals are tested to match finance pages. |
| 6 | Reports 56 ready-made reports, report All report IDs work with filters, builder, scheduling, exports drill-down, and PDF, Excel, and CSV ... | Partial | 56 ready-made reports work with filters and drill-down; see Reports partials. |
| 7 | Alerts and Alert rules, digest, automations, Each default alert fires on test channel | Done | Every one of the 19 default alerts has a test that makes it fire. Real email/SMS/Slack delivery was not run. |

## Pay rates — Notes for the builder

| # | Item | Status | Note |
|---|---|---|---|
| 1 | Follow shadcn/ui and shadcn-admin for look and structure, and confirm the licenses in the repos before copying code. | Done |  |
| 2 | If a feature here already exists in RouteNorth, improve it. Do not rebuild it. | Done |  |
| 3 | Ask the owner before changing how existing data is stored. | Done |  |
| 4 | Where this spec is silent, choose the simplest option that matches the reference design and write the choice down. | Done |  |
