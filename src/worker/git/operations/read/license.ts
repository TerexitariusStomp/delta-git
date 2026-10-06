// License-file detection vocabulary shared by the badge endpoint, the
// community-standards profile, and any future `detected_license` field.

export const LICENSE_NAME = /^(licen[sc]e|copying|unlicen[sc]e|notice)(\.\w{1,4})?$/i;

// Lightweight SPDX signature match on the first chunk of the license body.
export const LICENSE_SIGNATURES: [RegExp, string][] = [
  [/apache license\s+version 2\.0/i, "Apache-2.0"],
  [/mit license|permission is hereby granted, free of charge/i, "MIT"],
  [/gnu general public license\s+version 3|gpl-3/i, "GPL-3.0"],
  [/gnu general public license\s+version 2|gpl-2/i, "GPL-2.0"],
  [/gnu affero general public license/i, "AGPL"],
  [/gnu lesser general public license/i, "LGPL"],
  [/bsd 3-clause|bsd 2-clause|redistribution and use in source and binary forms/i, "BSD"],
  [/mozilla public license\s+version 2\.0|mpl-2/i, "MPL-2.0"],
  [/the unlicense|free and unencumbered software released into the public domain/i, "Unlicense"],
  [/creative commons/i, "CC"],
  [/isc license/i, "ISC"],
];
