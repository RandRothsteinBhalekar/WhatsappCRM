"use client";

export function createBrowserStorage() {
  return {
    from(bucket: string) {
      return {
        async upload(objectPath: string, file: File | Blob, _opts?: unknown) {
          const form = new FormData();
          form.set("bucket", bucket);
          form.set("path", objectPath);
          form.set("file", file);
          const res = await fetch("/api/media/upload", {
            method: "POST",
            credentials: "include",
            body: form,
          });
          const json = await res.json();
          if (!res.ok) {
            return { data: null, error: { message: json.error || "Upload failed" } };
          }
          return { data: { path: objectPath }, error: null };
        },
        async remove(paths: string[]) {
          const res = await fetch("/api/media/delete", {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ bucket, paths }),
          });
          const json = await res.json();
          if (!res.ok) {
            return { data: null, error: { message: json.error || "Delete failed" } };
          }
          return { data: paths, error: null };
        },
        getPublicUrl(objectPath: string) {
          const url = `/api/media/${bucket}/${objectPath
            .split("/")
            .map(encodeURIComponent)
            .join("/")}`;
          const absolute =
            typeof window !== "undefined"
              ? `${window.location.origin}${url}`
              : url;
          return { data: { publicUrl: absolute } };
        },
      };
    },
  };
}
