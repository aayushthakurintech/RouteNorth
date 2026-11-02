"use client";
import { useEffect, useState } from "react";
import { API_URL, loadSession } from "@/lib/session";
import { apiGet } from "@/lib/api";

interface ProofMeta { id: string; kind: "photo" | "signature"; takenAt: string }

/** Proof images need the bearer token, so they are fetched as blobs rather than used as <img src>. */
export function ProofGallery({ stopId, label }: { stopId: string; label: string }) {
  const [images, setImages] = useState<{ id: string; kind: string; url: string }[]>([]);

  useEffect(() => {
    let cancelled = false;
    const urls: string[] = [];
    (async () => {
      const metas = await apiGet<ProofMeta[]>(`/stops/${stopId}/proofs`);
      const token = loadSession()?.token;
      const loaded = await Promise.all(metas.map(async (m) => {
        const res = await fetch(`${API_URL}/proofs/${m.id}`, { headers: { Authorization: `Bearer ${token}` } });
        if (!res.ok) return null;
        const url = URL.createObjectURL(await res.blob());
        urls.push(url);
        return { id: m.id, kind: m.kind, url };
      }));
      if (!cancelled) setImages(loaded.filter((x): x is NonNullable<typeof x> => x !== null));
    })().catch(() => { /* gallery is a convenience; the route page still works */ });
    return () => { cancelled = true; urls.forEach((u) => URL.revokeObjectURL(u)); };
  }, [stopId]);

  if (images.length === 0) return null;
  return (
    <div className="proofs" role="group" aria-label={label}>
      {images.map((i) => (
        <a key={i.id} href={i.url} target="_blank" rel="noreferrer">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={i.url} alt={`${label}: ${i.kind}`} width={72} height={72} loading="lazy" />
        </a>
      ))}
    </div>
  );
}
