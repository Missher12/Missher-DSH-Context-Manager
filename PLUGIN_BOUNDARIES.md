# Plugin responsibilities

Context Manager owns context inspection, its archives and accounting, and enhanced pre-request/idle compaction when the Host exposes a supported capability and the current Agent is actually bound to this provider. Shared UI and session services come from the Host.

The neutral Bundle declares only Manager and Inspector root entries. It does not snapshot or overwrite Host presets, disable Basic, contain or depend on Session Bridge, mutate another plugin, or patch a Host through installation lifecycle hooks. Missing capabilities preserve native behavior and user configuration. See [compatibility and validation](PUBLICATION.md).

The release manifest enumerates the exact installable files. Development profiles, private review records, credentials and personal conversations are excluded. Removal retains session history, archives and accounting unless the user separately manages that data.
