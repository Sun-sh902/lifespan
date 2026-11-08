# Security Policy

Lifespan has no user accounts and is meant for a trusted home network. By default it listens on localhost only.

If you expose it beyond your own machine:

- Put it behind a reverse proxy with authentication (for example Authelia, Authentik or basic auth).
- Set `LIFESPAN_ALLOWED_HOSTS` to the host names you use, so DNS rebinding attacks are refused.
- Back up the data directory regularly.

## Reporting a vulnerability

Please do not open a public issue. Use GitHub's private vulnerability reporting on this repository ("Security" tab, "Report a vulnerability"). You will get a reply within a week.
