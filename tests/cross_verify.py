"""Cross-language parity check against the Python reference implementation.

Run tests/emit-vectors.ts first, then this script with proofline installed.
It proves that bundles written by the TypeScript extension verify byte-for-byte
under proofline's canonical JSON, digest, redaction, and pointer rules.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from proofline.model import canonical_json
from proofline.verify import verify_bundle

OUT = Path(__file__).resolve().parent.parent / "out"


def check_vectors() -> int:
    count = 0
    # JSONL frames on "\n" only; splitlines() would also split on U+2028 and
    # friends, which appear unescaped inside JSON strings.
    text = (OUT / "vectors.jsonl").read_text(encoding="utf-8")
    for line in filter(None, text.split("\n")):
        vector = json.loads(line)
        parsed = json.loads(vector["raw"])
        expected = canonical_json(parsed)
        if expected != vector["canonical"]:
            raise AssertionError(
                f"canonical mismatch\n raw:      {vector['raw']}\n"
                f" python:   {expected}\n typescript: {vector['canonical']}"
            )
        count += 1
    return count


def main() -> int:
    vectors = check_vectors()

    errors = verify_bundle(OUT / "bundle.json")
    if errors:
        print("bundle.json failed verification:", *errors, sep="\n  ")
        return 1

    tamper_errors = verify_bundle(OUT / "tampered.json")
    if not tamper_errors:
        print("tampered.json unexpectedly verified clean")
        return 1

    print(
        f"OK: {vectors} vectors match, TypeScript bundle verifies, "
        f"tampering detected ({len(tamper_errors)} error(s))"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
