# Third-party notices

## vendor/tf2lzham/tf2lzham.wasm

LZHAM alpha8 as modified for Titanfall 2 VPKs, compiled to WebAssembly by pg9182/tf2lzham
(revision in `vendor/tf2lzham/REVISION`). MIT License, copyright (c) 2022 pg9182; the license text
is `vendor/tf2lzham/LICENSE`. LZHAM itself is MIT-licensed, copyright (c) 2009-2011 Richard Geldreich, Jr.

## npm dependencies

| Package | License |
|---|---|
| audify | MIT |
| koffi | MIT |
| jpeg-js | BSD-3-Clause |
| opencc-js | MIT AND Apache-2.0 |

## Titanfall 2

No file of the game ships in this package. At run time the World reads the player's own copy of
the game: the dialogue script it patches, the subtitle table, and the voice line used as the
VoxCPM2 reference. The Miles bank layout follows LegionPlus (r-ex/LegionPlus, GPL-3.0); no
LegionPlus code is included.
