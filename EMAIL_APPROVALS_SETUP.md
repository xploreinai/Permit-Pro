# Email approvals — how it works and how to switch it on

## How it works

1. A vendor submits a permit. The app calls `/api/request-approval`.
2. The server emails the Engineering approver(s) — and, for High-Risk permits, the HCC Manager — a summary with a **Review & decide** link. The recipients come from server settings, never from the browser.
3. The approver can respond two ways:
   - **Link** → opens a page with **Approve** / **Reject** buttons. (The link itself never approves anything, because mail scanners open links automatically.)
   - **Reply** → just answer the email with `Approved` / `Rejected`.
4. The permit updates exactly as if it had been approved in the app (Engineering → "Awaiting Gate 3 Check-In"; HCC → clears the HCC gate at Security). An audit-trail entry is written and the approver gets a confirmation email.

### Safeguards
- Link tokens are 256-bit random, stored only as a hash, single-use, and expire after 7 days.
- A reply counts only if: the webhook signature is valid, the secret code in the reply address matches, the sender is exactly the approver the email went to, **SPF or DKIM passed**, and the wording is unambiguous. "Approved but only Monday", questions, and anything unclear change nothing and the approver is asked to use the link.
- If an approver approves in the app first, any email links for that permit stop working.
- The `approval_requests` table is unreadable with the public key; only the server can touch it.

### Honest limits
- An approver's mailbox is the weak point: anyone who can read or forward the email can use the link. Emails say "do not forward".
- Reply-approval depends on the provider's SPF/DKIM results; if a reply can't be verified it is refused, not trusted.

## Switch it on (about 20 minutes)

1. **Supabase** → SQL Editor → run `supabase/migrations/004_approval_requests.sql`.
2. **Resend** (free plan is enough): create an account and an API key.
3. **Sending domain**: in Resend → Domains, add and verify a domain you control (it gives you DNS records to add). Without a verified domain, Resend only delivers to your own address, which is fine for a first test.
4. **Reply address** (optional, free): Resend → Emails → Receiving → copy the `…resend.app` address. This is `INBOUND_REPLY_DOMAIN`.
5. **Webhook** (only for replies): Resend → Webhooks → Add endpoint `https://YOUR-APP.vercel.app/api/inbound-email`, event `email.received`. Copy its signing secret (`whsec_…`).
6. **Supabase service-role key**: Settings → API → `service_role` (secret).
7. **Vercel** → Settings → Environment Variables: add everything in `.env.server.example`, then redeploy.

## Test it
1. Submit a permit (as a vendor) with your own email as the approver → you should get an email within a minute.
2. Press **Review & decide** → **Approve**; confirm the permit moves to "Awaiting Gate 3 Check-In".
3. Submit another; this time reply `Approved` from the same address.
4. Reply `approved but only Monday` to a third → nothing should change and you get a "couldn't read your reply" email.

If emails aren't configured, the app keeps working exactly as before — approvers just use the Engineering tab.

Server tests: `npm run test:server`
