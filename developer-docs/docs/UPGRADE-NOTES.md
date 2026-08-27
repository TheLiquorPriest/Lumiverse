# Upgrade Notes

## 2026-08-22 — Spindle provider registration permissions are now privileged

The `providers.embedding.register`, `providers.tts.register`, `providers.stt.register`,
and `providers.sidecar.register` permissions are now **PRIVILEGED**. Existing deployed
provider extensions that relied on implicit registration grants will lose the ability
to register their providers after upgrading; an operator must explicitly grant these
permissions per extension.
