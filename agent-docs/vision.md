# Vision and Users

## The core insight: labels, not folders

People use folders as hashtags — `inProgress`, `underReview`, `toCustomer`, nested under duplicated template trees. Often there are more empty template folders than actual files. Folders pretend to be collections, but they're really *labels that change over time.*

Atlas Explorer flattens that. Apply labels (categories, tags) that can change, and let the underlying filesystem stay clean. This is the heart of the value proposition.

## Primary use case: PLC programming

PLC programming sits in the muddy middle between software-engineering tools (git, VCS, IDE workflows) and Office productivity tools (Word, Excel, SharePoint). Files get dropped on shared SMB servers. There's no organizational appetite for a "grand management suite" — and dropping one in is a non-starter.

So Atlas Explorer must:

- **Sit atop the plain filesystem.** Don't fight it, don't replace it, don't hide it.
- **Add richer functionality** — categories, tags, audit trails, monitoring rules, alerts, notes — without disrupting the "just put it on the server" workflow.
- **Coexist** with users who don't (and won't) install Atlas Explorer.

## Secondary use case: personal photo organization

The same insights apply to a camera roll: too many files, organization deferred forever, labels would help more than folders.

## Public vision

> "Whoever wants it will know it when they see it."

Existing alternatives haven't pushed far enough outside the box to displace Windows File Explorer for power users. Atlas Explorer aims to.

## Target user

| Today                     | Eventually                                                                  |
|---------------------------|-----------------------------------------------------------------------------|
| Matt — across 2-3 devices | Anyone working with files who doesn't have access to anything fancy.        |

A "power user" in this app's context is someone who:

- Knows enough about computers to want a checksum, an audit history, a monitoring rule.
- Is willing to sit down and configure a stack of monitoring/tagging/alerting rules to their own benefit.
- Doesn't expect to read a manual, but is happy to discover features through exploration.

## What the app is optimizing for

- The "files are files, files are king" workflow.
- Speed where speed matters (search across large file servers).
- Accessibility where accessibility matters (notes readable on a phone, a thumbdrive, anywhere).
- Long-term code coherence — Matt wants to still be able to tweak things himself a year and three years from now.

## Time horizons (as of 2026-05)

- **1 month** — Daily-driver at work because it makes life easier.
- **1 year** — Can't live without it. Some public users love it.
- **3 years** — Open. Goal: code stays logical and coherent throughout.
