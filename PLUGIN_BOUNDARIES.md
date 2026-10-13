# Plugin responsibilities

Context Manager owns pre-request and idle compaction, bounded same-session original-text lookup, its archive and accounting, and the conversation Context view. Shared UI and session services come from the Host.

The package does not contain or depend on Session Bridge, mutate another plugin, or use installation lifecycle hooks to patch a Host. Narrow-preset and new-input continuation support must be supplied by the paired Host release; see [compatibility and validation](PUBLICATION.md).

The runtime tarball contains the declared 23 product files. Development profiles, private review records, credentials and personal conversations are excluded. Removal retains existing session history, archives and accounting unless the user separately manages that data.
