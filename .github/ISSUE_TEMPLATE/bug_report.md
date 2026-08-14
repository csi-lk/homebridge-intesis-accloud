---
name: Bug report
about: Report a bug with homebridge-intesis-accloud
title: ''
labels: bug
assignees: ''
---

**Describe the bug**
A clear and concise description of what's happening (e.g. "toggling power in
Apple Home does nothing", "temperature not updating").

**To reproduce**
Steps to reproduce the behaviour:
1. ...
2. ...

**Logs**
Please enable debug logging first — in the Homebridge UI go to
**Settings → Logs → Debug logging** and enable it for `homebridge-intesis-accloud`,
then reproduce the issue and paste the relevant `[IntesisWeb]` log lines below.

```
<paste logs here>
```

**Environment**
- Plugin version: (e.g. `1.0.9`, from Homebridge UI → Plugins → homebridge-intesis-accloud)
- Homebridge version: (from Settings → About)
- Node.js version: (if known)
- Device / OS running Homebridge: (e.g. Raspberry Pi 4 / Debian 12)

**Additional context**
Anything else that might help, e.g.:
- Does it fail right after Homebridge starts, or after a period of inactivity?
- Does it affect one device or all devices?
- Does toggling the AC via the Intesis app work at the same time?
