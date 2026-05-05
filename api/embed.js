"""
Papyrates — Batch Embedding Script
===================================
Reads all letters from Supabase that don't have embeddings yet,
sends them to Voyage AI in batches, and writes the vectors back.

Run once:  python embed_letters.py
Resumable: if interrupted, re-run — already-embedded letters are skipped.

Requirements:
    pip install requests

Cost estimate: ~7,332 letters × ~500 tokens avg = ~3.6M tokens
               voyage-large-2 = $0.12 / 1M tokens → ~$0.43 total
"""

import requests
import time
import sys

# ── CONFIG ────────────────────────────────────────────────────────────────────

SUPABASE_URL  = "https://vzfwobsnfqnnqvnsfksq.supabase.co/rest/v1"
SUPABASE_KEY  = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZ6ZndvYnNuZnFubnF2bnNma3NxIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3Njg4ODA3MCwiZXhwIjoyMDkyNDY0MDcwfQ.J_TE4qWj9r6TIvGeptM58r2WtI6ytOe9zg7BBe29wHI"
VOYAGE_KEY    = "pa-llPMSdgZ6itg4xUTTbXhdaEWCAZ-fKQ_AlSe1Rttkzb"
VOYAGE_MODEL  = "voyage-large-2"   # 1536 dimensions — matches your vector column
BATCH_SIZE    = 64                 # safe batch size for Voyage AI
FETCH_LIMIT   = 500               # how many letters to fetch from Supabase at once
TEXT_LIMIT    = 4000              # max chars per letter sent to Voyage (keeps tokens low)

SB_HEADERS = {
    "apikey":        SUPABASE_KEY,
    "Authorization": f"Bearer {SUPABASE_KEY}",
    "Content-Type":  "application/json",
    "Prefer":        "return=minimal"
}

# ── HELPERS ───────────────────────────────────────────────────────────────────

def fetch_letters_without_embeddings(offset):
    """Fetch a page of letters that still have a NULL vector column."""
    url = (f"{SUPABASE_URL}/letters"
           f"?select=id,description,full_text"
           f"&embedding=is.null"
           f"&limit={FETCH_LIMIT}&offset={offset}")
    r = requests.get(url, headers=SB_HEADERS, timeout=30)
    r.raise_for_status()
    return r.json()


def build_text(letter):
    """Combine description + full_text into a single string to embed."""
    parts = []
    if letter.get("description"):
        parts.append(letter["description"].strip())
    if letter.get("full_text"):
        parts.append(letter["full_text"].strip()[:TEXT_LIMIT])
    return " ".join(parts) if parts else None


def get_embeddings(texts):
    """Call Voyage AI and return list of embedding vectors."""
    r = requests.post(
        "https://api.voyageai.com/v1/embeddings",
        headers={
            "Authorization": f"Bearer {VOYAGE_KEY}",
            "Content-Type":  "application/json"
        },
        json={"input": texts, "model": VOYAGE_MODEL},
        timeout=60
    )
    r.raise_for_status()
    data = r.json()
    return [item["embedding"] for item in data["data"]]


def save_embedding(letter_id, embedding):
    """PATCH the vector column on a single letter row."""
    url = f"{SUPABASE_URL}/letters?id=eq.{letter_id}"
    r = requests.patch(url, headers=SB_HEADERS, json={"embedding": embedding}, timeout=30)
    if r.status_code not in (200, 204):
        print(f"  ⚠  Failed to save embedding for letter {letter_id}: {r.status_code} {r.text[:120]}")
    return r.status_code


# ── MAIN ──────────────────────────────────────────────────────────────────────

def main():
    print("🏴‍☠️  Papyrates Batch Embedder")
    print(f"   Model : {VOYAGE_MODEL}  (1536 dimensions)")
    print(f"   Batch : {BATCH_SIZE} letters at a time\n")

    offset          = 0
    total_embedded  = 0
    total_skipped   = 0   # letters with no text at all
    errors          = 0

    while True:
        # ── Fetch a page of un-embedded letters ──────────────────────────────
        try:
            letters = fetch_letters_without_embeddings(offset)
        except Exception as e:
            print(f"  ✗ Supabase fetch error at offset {offset}: {e}")
            time.sleep(10)
            continue

        if not letters:
            print("✅  No more letters to embed — all done!")
            break

        # ── Build text payloads, skip letters with no usable text ─────────────
        batch_data = []
        for l in letters:
            text = build_text(l)
            if text:
                batch_data.append((l["id"], text))
            else:
                total_skipped += 1

        if not batch_data:
            offset += len(letters)
            continue

        # ── Send to Voyage AI in sub-batches of BATCH_SIZE ───────────────────
        for i in range(0, len(batch_data), BATCH_SIZE):
            sub      = batch_data[i : i + BATCH_SIZE]
            ids      = [x[0] for x in sub]
            texts    = [x[1] for x in sub]

            try:
                embeddings = get_embeddings(texts)
            except Exception as e:
                print(f"  ✗ Voyage AI error: {e} — retrying in 10s…")
                time.sleep(10)
                try:
                    embeddings = get_embeddings(texts)
                except Exception as e2:
                    print(f"  ✗ Retry failed: {e2} — skipping this sub-batch")
                    errors += len(ids)
                    continue

            # Write each vector back to Supabase
            for letter_id, embedding in zip(ids, embeddings):
                save_embedding(letter_id, embedding)
                total_embedded += 1

            pct = ""
            sys.stdout.write(
                f"\r   Embedded: {total_embedded:,}  |  Skipped: {total_skipped}  |  Errors: {errors}   "
            )
            sys.stdout.flush()

            # Gentle rate-limit pause
            time.sleep(0.3)

        offset += len(letters)

        # Stop if we got fewer results than the fetch limit (last page)
        if len(letters) < FETCH_LIMIT:
            break

    print(f"\n\n🏁  Finished!")
    print(f"   Total embedded : {total_embedded:,}")
    print(f"   Skipped (no text): {total_skipped}")
    print(f"   Errors           : {errors}")


if __name__ == "__main__":
    main()
