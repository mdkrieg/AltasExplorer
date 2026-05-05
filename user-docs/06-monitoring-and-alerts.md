# 6. Monitoring & Alerts

← [Back to Contents](index.md)

---

## Background Monitoring

Atlas Explorer can watch directories in the background for filesystem changes — files added, modified, deleted, or renamed. Enable it in **Settings → Browser** and configure the polling interval.

Initial events (the first scan of a directory you haven't visited before) are treated separately from ongoing changes and will not trigger alerts, to avoid noise on first browse.

## Monitoring Rules

Monitoring rules define *what* to watch. Each rule targets a combination of:

- **Category** — directories assigned a particular category (or "any")
- **Tags** — items carrying specific tags (or "any")
- **Attributes** — items with particular attribute values (or "any")

When a filesystem change matches a rule, the event is recorded in the audit trail and can optionally trigger an alert.

Configure rules in **Settings → Alerts & Monitoring**.

## Alerts

Alerts fire when a monitored change meets the conditions defined in your alert rules. Each alert rule specifies:

- The category / tag / attribute combination to watch
- The type of change that triggers it (file added, deleted, modified, renamed, etc.)

Alerts appear as notifications in the app and are listed in the Alert Summary.

## Alert Summary

The Alert Summary shows all pending alerts. You can:

- Acknowledge individual alerts
- Select All and bulk-acknowledge

## Audit Trail & History

Atlas Explorer records a history of changes as you browse — file additions, deletions, modifications, category assignments, and more. The history for any individual item is accessible from its **Item Properties** view.

## Checksums

Checksum monitoring (SHA-based) can be enabled per category. When Atlas detects that a file's checksum has changed since the last scan, that change is recorded in the audit trail and can trigger an alert if a matching rule exists.
