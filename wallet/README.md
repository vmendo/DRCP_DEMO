# Wallet Directory

Place your Oracle wallet files here for local development only.

This directory is ignored by Git except for this README. Do not commit wallet files, certificates, keystores, truststores, private keys, or wallet zip archives.

Typical local files include:

- `tnsnames.ora`
- `sqlnet.ora`
- `cwallet.sso`
- `ewallet.p12`
- `ewallet.pem`
- `keystore.jks`
- `truststore.jks`

Set `DEMO_TNS_ADMIN` in `config/demo.env` to the absolute path of the wallet directory.

Your `tnsnames.ora` should include both a normal alias and a pooled alias. The pooled alias must include `SERVER=POOLED` in the connect data.
