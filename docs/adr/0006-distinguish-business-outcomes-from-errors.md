# Distinguish business outcomes from errors

Processed operations, idempotent replays and business rejections return successful HTTP outcomes, pending references return `202`, contract failures use stable `4xx` responses and transient infrastructure failures use `503`. Stable machine-readable failure codes let providers decide whether to retry without interpreting human-readable messages.
