# Stripe Connect onboarding — Norway

Updated 2026-09-22 after the Direct Charge decision.

Norway is in Mercatai's EU/EEA + UK rollout. Hosted Express onboarding does
not preselect a legal form; the account holder confirms the appropriate
`business_type` and completes Stripe verification.

New payments are Direct Charges in the Norwegian connected account, not
cross-border destination charges from the Czech platform. Mercatai receives
only its application fee. Payment creation still requires live
`charges_enabled`, `payouts_enabled` and the active capability for the
chosen method.

Stripe lists Norway as a SEPA Direct Debit business location, so Mercatai
requests both `card_payments` and `sepa_debit_payments`. The legacy
`transfers` capability is not a Direct Charge prerequisite.

Earlier DE/NO tests verified hosted onboarding, card and SEPA test payments,
refund behavior and Stripe test-mode payout simulation under the former
destination-charge implementation. They did not prove a live bank payout.
The Direct Charge rollout must be re-tested in test mode, and Mercatai must
not claim a Norwegian live bank payout until a small real pilot reaches the
operator's bank.

Operational steps are in:

- `docs/eu-payments-rollout.md`
- `docs/migration-21-direct-charges-runbook.md`
