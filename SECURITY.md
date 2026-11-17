# Security

Report a vulnerability to security@recordist.app, with the version
(`npx -y @recordist/gateway --version`) and a way to reproduce. We acknowledge reports
within 3 business days and aim to ship a fix for confirmed high-severity issues within
14 days. Recordist's vulnerability disclosure policy, https://recordist.app/security/disclosure,
sets out the scope, the time we ask before publication and the safe harbour for good-faith
research.

The gateway binds to 127.0.0.1 by default and authenticates to the Recordist app with the
token the app keeps on the same device.
