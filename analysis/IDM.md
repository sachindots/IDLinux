# IDM 6.43 build 18 installer analysis

I inspected the supplied Windows installer statically. The observations below concern this specific file. The Linux transfer engine and interface come from the separately supplied MIT-licensed source archive.

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| idman643build18.exe | 12,164,608 | `7346128fab42957b4254eabdb012bfdbd751e9069361e98a6916f26bb03d62ee` |
| Embedded IDMan.exe | 6,517,616 | `a705c0154fafc7cd509decf165cb6f6c050b6521b40adb6f730dd827c86051c7` |
| Supplied source archive | 2,310,187 | `9ef8a8bf99e294ee5c1c5e06b100eaf671332bbd31acb0f06bf007b8d1848ea1` |

## Observations

1. REA's PE resource inspector identified a 32-bit x86 Windows installer with seven resources, including a dialog, icons, version information and a manifest. The version resource identifies the file as the Internet Download Manager installer, version 6.43.18.1.
2. The data following the PE sections begins at file offset `0x17400`. Decoding the first zlib stream after its 32-byte record header yields an installation inventory. It names the main GUI, Chrome and Firefox extension packages and a separate browser messaging host. The compressed main executable starts at `0xb4c0a`.
3. REA inspected the extracted main executable. Its PE resource tree contains 436 resources, and objdump reports the i386 architecture and entry point `0x00684dec`. UTF-16 UI text in the executable identifies manual URL entry, start/resume, stop, download queues and resume capability. Static UI text establishes that those controls exist. It gives no measurement of speed or proof of a particular scheduling algorithm.
4. Two embedded JSON manifests register the same stdio native-messaging host. One authorizes Chromium extension origins, and the other authorizes a Firefox extension ID. This establishes how the browser discovers IDM's helper. The application's private message format was outside the inspection.

The installer inventory also contains installation and launch directives. They were treated as artifact data. Neither the installer nor its embedded executables were run or included in the Linux distribution.

## REA evidence identifiers

| Operation | Artifact | Evidence |
| --- | --- | --- |
| inspect_pe_resources | Installer | `ev_30108d57a59046f7e081241338bab9c559c521e9fb7de7290eb4a6b261b6ab79` |
| inspect_pe_resources | Embedded IDMan.exe | `ev_70f7b263b6ed78c98edf55e9c23a5e92efb7718b5aa1739dd60a07db885026a1` |
| inspect_with_objdump, file_headers | Embedded IDMan.exe | `ev_f7bd0e4f67a5c692b417b766ac1bf4b322365cf1b7034e96d0c477b64d8e3cae` |

## Linux implementation

ID Linux gives the extension its own identity and a Python stdio host. The host connects to the Electron app through a Unix socket inside a per-user directory. The probe, confirmation and queue logic handle the download. A right-click also works on audio and video elements with direct HTTP(S) sources. ID Linux keeps its settings and download manifests under its own configuration directory.
