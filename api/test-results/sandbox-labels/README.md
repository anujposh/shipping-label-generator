# Sandbox FedEx international verification

Generated: 2026-11-11T14:14:11.844Z

**Scenario:** international-us-ca | **ETD upload:** yes | **Duty estimate:** no

**Sandbox only.** These are carrier test artifacts, not evidence of a physical shipment. No credentials, raw carrier responses, or request payloads are included.

## Results

- Internal API missing/wrong Bearer rejection: passed
- Label: Created (1 page)
- Label artifact: `api/test-results/sandbox-labels/fedex-international-us-ca-sandbox.pdf`
- Documents returned: 2
- CERTIFICATE_OF_ORIGIN (PDF): `api/test-results/sandbox-labels/fedex-international-us-ca-sandbox-CERTIFICATE_OF_ORIGIN-794908829308.pdf`
- COMMERCIAL_INVOICE (PDF): `api/test-results/sandbox-labels/fedex-international-us-ca-sandbox-COMMERCIAL_INVOICE-794908829308.pdf`
- Duty-tax estimate: Not requested
- ETD upload attempt: Attached (see ETD label artifact)
- ETD documents: `api/test-results/sandbox-labels/fedex-international-us-ca-sandbox-etd-COMMERCIAL_INVOICE-794908829400.pdf`, `api/test-results/sandbox-labels/fedex-international-us-ca-sandbox-etd-CERTIFICATE_OF_ORIGIN-794908829400.pdf`, `api/test-results/sandbox-labels/fedex-international-us-ca-sandbox-etd-COMMERCIAL_INVOICE-794908829400.pdf`
- Overall: PASS

ETD and duty-tax are optional FedEx sub-flows; failures there do not fail the base label check. Duty-tax figures are non-guaranteed. Machine-readable, redacted evidence is in `results.json`.
