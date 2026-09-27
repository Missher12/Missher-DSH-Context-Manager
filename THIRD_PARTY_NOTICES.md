# Third-party configuration

`cordis.patch.yml` contains generated derivatives of three preset configurations
from DeepSeek Harness, Copyright (c) 2026 DeepSeek, distributed under the MIT
License in `LICENSE`. The original paths, version, commit and SHA-256 values
are recorded in `COMPATIBILITY.json`.

The plugin imports Harness's compaction engine and public runtime services. It
does not redistribute their built implementations inside its JavaScript bundle.

The client also imports Harness's shared UI primitives without bundling a second
copy. Its settings layout follows the MIT-licensed Harness settings styles and
uses the host's `--dsw-*` theme tokens.

Context diagnostics were informed by the public documentation and architecture
of bowenliang123/dsh-context (Apache-2.0), inspected at commit
43274f99829cc94347af7f830460a4c8baddb23f. This package contains no copied source
from that project and has no runtime dependency on it.

## Zod 4.4.3

The browser bundle includes Zod for its private Remote boundary codecs.

MIT License

Copyright (c) 2025 Colin McDonnell

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
