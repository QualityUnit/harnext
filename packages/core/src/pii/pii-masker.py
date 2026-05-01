"""Long-running PII masker daemon.

Loads OpenMed/OpenMed-PII-SuperClinical-Small-44M-v1 once at startup, then
serves mask requests over stdin/stdout as line-delimited JSON. Pure model
output — no regex catchers.

Protocol:
  startup: emit {"ready": true} once the model is loaded
  request: {"text": "..."} per line on stdin
  response: {"masked": "...", "entities": [...]} or {"error": "..."} per line
"""

import json
import sys

from transformers import pipeline

MODEL_ID = "OpenMed/OpenMed-PII-SuperClinical-Small-44M-v1"


def trim_span(e, text):
    s, end = e["start"], e["end"]
    while s < end and text[s].isspace():
        s += 1
    while end > s and text[end - 1].isspace():
        end -= 1
    e["start"], e["end"] = s, end
    e["word"] = text[s:end]
    return e


def dedupe(entities):
    """Resolve overlapping spans — longer span wins, ties by score."""
    entities = sorted(entities, key=lambda x: -(x["end"] - x["start"]))
    kept = []
    for e in entities:
        if any(e["start"] < k["end"] and e["end"] > k["start"] for k in kept):
            continue
        kept.append(e)
    return sorted(kept, key=lambda x: x["start"])


def merge_adjacent(entities, text):
    """Merge consecutive same-label entities separated only by whitespace."""
    merged = []
    for e in sorted(entities, key=lambda x: x["start"]):
        if (
            merged
            and merged[-1]["entity_group"] == e["entity_group"]
            and text[merged[-1]["end"] : e["start"]].strip() == ""
        ):
            prev = merged[-1]
            prev["end"] = e["end"]
            prev["word"] = text[prev["start"] : prev["end"]]
            prev["score"] = min(prev["score"], e["score"])
        else:
            merged.append({**e, "word": text[e["start"] : e["end"]]})
    return merged


def detect_pii(text, ner):
    raw = ner(text)
    cleaned = [trim_span(dict(e), text) for e in raw]
    cleaned = [e for e in cleaned if e["start"] < e["end"]]
    cleaned = dedupe(cleaned)
    return merge_adjacent(cleaned, text)


def mask_text(text, entities):
    out = []
    cursor = 0
    for e in sorted(entities, key=lambda x: x["start"]):
        out.append(text[cursor : e["start"]])
        out.append(f"[{e['entity_group'].upper()}]")
        cursor = e["end"]
    out.append(text[cursor:])
    return "".join(out)


def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def main():
    try:
        ner = pipeline("ner", model=MODEL_ID, aggregation_strategy="simple")
    except Exception as exc:
        emit({"error": f"failed to load model: {exc}"})
        sys.exit(1)
    emit({"ready": True})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError as exc:
            emit({"error": f"invalid json: {exc}"})
            continue
        text = req.get("text", "")
        if not isinstance(text, str):
            emit({"error": "text must be a string"})
            continue
        try:
            entities = detect_pii(text, ner)
            entities = [
                {
                    "entity_group": e["entity_group"],
                    "start": int(e["start"]),
                    "end": int(e["end"]),
                    "word": e["word"],
                    "score": float(e["score"]),
                }
                for e in entities
            ]
            emit({"masked": mask_text(text, entities), "entities": entities})
        except Exception as exc:
            emit({"error": f"detect failed: {exc}"})


if __name__ == "__main__":
    main()
