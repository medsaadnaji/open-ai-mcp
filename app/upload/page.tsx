"use client";

import { useEffect, useState } from "react";

/**
 * Upload page: pick images on your phone or computer, get public links to paste
 * into the chat as references. Open it as /upload?k=<MCP_SECRET> (bookmark that),
 * or enter the password once; it is remembered in this browser.
 */

type Item = {
  id: string;
  name: string;
  preview: string;
  status: "uploading" | "done" | "error" | "deleting";
  url?: string;
  error?: string;
};

const MAX_SIDE = 2048; // large enough for any reference, small enough to upload fast

/** Shrink big images in the browser before upload. Small PNGs keep their transparency. */
async function prepare(file: File): Promise<Blob> {
  if (file.type === "image/png" && file.size < 3_000_000) return file;
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  if (scale === 1 && file.size < 3_000_000 && file.type !== "image/heic") return file;
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Could not convert image"))), "image/jpeg", 0.9),
  );
}

export default function UploadPage() {
  const [secret, setSecret] = useState("");
  const [draft, setDraft] = useState("");
  const [items, setItems] = useState<Item[]>([]);
  const [copied, setCopied] = useState<string | null>(null);
  const [viewing, setViewing] = useState<Item | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  useEffect(() => {
    const fromUrl = new URLSearchParams(window.location.search).get("k");
    let saved: string | null = null;
    try {
      saved = window.localStorage.getItem("upload-k");
    } catch {}
    const k = fromUrl || saved || "";
    if (k) {
      setSecret(k);
      try {
        window.localStorage.setItem("upload-k", k);
      } catch {}
    }
  }, []);

  function saveSecret() {
    const k = draft.trim();
    if (!k) return;
    setSecret(k);
    try {
      window.localStorage.setItem("upload-k", k);
    } catch {}
  }

  function update(id: string, patch: Partial<Item>) {
    setItems((list) => list.map((it) => (it.id === id ? { ...it, ...patch } : it)));
  }

  async function onFiles(files: FileList | null) {
    if (!files) return;
    for (const file of Array.from(files)) {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      setItems((list) => [{ id, name: file.name, preview: URL.createObjectURL(file), status: "uploading" }, ...list]);
      try {
        const body = await prepare(file);
        const res = await fetch(`/api/upload?k=${encodeURIComponent(secret)}&name=${encodeURIComponent(file.name)}`, {
          method: "POST",
          body,
        });
        const data = await res.json();
        if (res.status === 401) {
          setSecret("");
          try {
            window.localStorage.removeItem("upload-k");
          } catch {}
        }
        if (!res.ok) throw new Error(data.error ?? `Upload failed (${res.status})`);
        update(id, { status: "done", url: data.url });
      } catch (err) {
        update(id, { status: "error", error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  async function remove(it: Item) {
    setConfirming(null);
    if (!it.url) {
      setItems((list) => list.filter((x) => x.id !== it.id));
      return;
    }
    update(it.id, { status: "deleting", error: undefined });
    try {
      const res = await fetch(`/api/upload?k=${encodeURIComponent(secret)}&url=${encodeURIComponent(it.url)}`, {
        method: "DELETE",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `Delete failed (${res.status})`);
      setItems((list) => list.filter((x) => x.id !== it.id));
    } catch (err) {
      update(it.id, { status: "done", error: err instanceof Error ? err.message : String(err) });
    }
  }

  async function copy(text: string, key: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      setTimeout(() => setCopied(null), 1500);
    } catch {}
  }

  const done = items.filter((i) => i.url);

  return (
    <main style={styles.main}>
      <h1 style={styles.h1}>Upload reference images</h1>
      <p style={styles.lead}>Pick images, then paste the links into your chat with Claude.</p>

      {!secret ? (
        <div style={styles.card}>
          <label style={styles.label}>Password (your MCP_SECRET)</label>
          <input
            style={styles.input}
            type="password"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && saveSecret()}
            autoComplete="current-password"
          />
          <button style={styles.button} onClick={saveSecret}>
            Continue
          </button>
        </div>
      ) : (
        <>
          <label style={styles.pick}>
            Choose images
            <input type="file" accept="image/*" multiple hidden onChange={(e) => onFiles(e.target.files)} />
          </label>

          {done.length > 1 && (
            <button style={styles.secondary} onClick={() => copy(done.map((i) => i.url).join("\n"), "all")}>
              {copied === "all" ? "Copied" : `Copy all ${done.length} links`}
            </button>
          )}

          <ul style={styles.list}>
            {items.map((it) => (
              <li key={it.id} style={styles.item}>
                <button style={styles.thumbButton} onClick={() => setViewing(it)} aria-label="Preview">
                  <img src={it.preview} alt="" style={styles.thumb} />
                </button>
                <div style={styles.info}>
                  <div style={styles.name}>{it.name}</div>
                  {it.status === "uploading" && <div style={styles.muted}>Uploading…</div>}
                  {it.status === "deleting" && <div style={styles.muted}>Deleting…</div>}
                  {it.error && <div style={styles.error}>{it.error}</div>}
                  {it.url && (
                    <button style={styles.copy} onClick={() => copy(it.url!, it.id)}>
                      {copied === it.id ? "Copied" : "Copy link"}
                    </button>
                  )}
                </div>
                {it.status !== "uploading" && it.status !== "deleting" &&
                  (confirming === it.id ? (
                    <div style={styles.confirm}>
                      <button style={styles.confirmYes} onClick={() => remove(it)}>
                        Delete
                      </button>
                      <button style={styles.confirmNo} onClick={() => setConfirming(null)}>
                        Keep
                      </button>
                    </div>
                  ) : (
                    <button style={styles.x} onClick={() => setConfirming(it.id)} aria-label="Delete">
                      ×
                    </button>
                  ))}
              </li>
            ))}
          </ul>

          {viewing && (
            <div style={styles.overlay} onClick={() => setViewing(null)}>
              <img src={viewing.url ?? viewing.preview} alt="" style={styles.full} />
              <button style={styles.close} onClick={() => setViewing(null)} aria-label="Close">
                ×
              </button>
            </div>
          )}

          <button
            style={styles.link}
            onClick={() => {
              setSecret("");
              try {
                window.localStorage.removeItem("upload-k");
              } catch {}
            }}
          >
            Forget password on this device
          </button>
        </>
      )}
    </main>
  );
}

const styles: Record<string, React.CSSProperties> = {
  main: { maxWidth: 520, margin: "0 auto", padding: "32px 20px", fontFamily: "system-ui, -apple-system, sans-serif", color: "#1a1a1a" },
  h1: { fontSize: 22, margin: "0 0 6px" },
  lead: { margin: "0 0 24px", color: "#555", fontSize: 15 },
  card: { display: "flex", flexDirection: "column", gap: 10 },
  label: { fontSize: 14, color: "#555" },
  input: { padding: "12px 14px", fontSize: 16, border: "1px solid #ccc", borderRadius: 10 },
  button: { padding: "12px 14px", fontSize: 16, border: 0, borderRadius: 10, background: "#1a1a1a", color: "#fff" },
  pick: { display: "block", textAlign: "center", padding: "18px 14px", fontSize: 17, borderRadius: 12, background: "#1a1a1a", color: "#fff", cursor: "pointer" },
  secondary: { marginTop: 12, width: "100%", padding: "12px 14px", fontSize: 15, border: "1px solid #1a1a1a", borderRadius: 10, background: "#fff" },
  list: { listStyle: "none", padding: 0, margin: "20px 0 0", display: "flex", flexDirection: "column", gap: 12 },
  item: { display: "flex", gap: 12, alignItems: "center", padding: 10, border: "1px solid #e5e5e5", borderRadius: 12 },
  thumbButton: { padding: 0, border: 0, background: "none", cursor: "zoom-in", flexShrink: 0 },
  thumb: { display: "block", width: 64, height: 64, objectFit: "cover", borderRadius: 8, background: "#f3f3f3" },
  x: { width: 36, height: 36, flexShrink: 0, border: 0, borderRadius: 18, background: "#f3f3f3", fontSize: 22, lineHeight: "36px", color: "#555" },
  confirm: { display: "flex", flexDirection: "column", gap: 6, flexShrink: 0 },
  confirmYes: { padding: "6px 10px", fontSize: 13, border: 0, borderRadius: 8, background: "#b42318", color: "#fff" },
  confirmNo: { padding: "6px 10px", fontSize: 13, border: 0, borderRadius: 8, background: "#eef0f3" },
  overlay: { position: "fixed", inset: 0, background: "rgba(0,0,0,0.88)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16, zIndex: 10 },
  full: { maxWidth: "100%", maxHeight: "100%", objectFit: "contain", borderRadius: 6 },
  close: { position: "fixed", top: 14, right: 14, width: 44, height: 44, border: 0, borderRadius: 22, background: "rgba(255,255,255,0.15)", color: "#fff", fontSize: 28, lineHeight: "44px" },
  info: { flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 6 },
  name: { fontSize: 14, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  muted: { fontSize: 13, color: "#777" },
  error: { fontSize: 13, color: "#b42318" },
  copy: { alignSelf: "flex-start", padding: "8px 12px", fontSize: 14, border: 0, borderRadius: 8, background: "#eef0f3" },
  link: { marginTop: 28, border: 0, background: "none", color: "#777", fontSize: 13, textDecoration: "underline" },
};
