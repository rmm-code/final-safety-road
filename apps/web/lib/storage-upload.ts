/**
 * Upload one image straight to object storage with a signed POST form from the API.
 *
 * A form, not a PUT: storage enforces the content type and size the API signed, so the
 * endpoint cannot be used to upload anything but the one image it was issued for. Every
 * signed field goes first and the file goes last - storage ignores fields after the file.
 */
export type StorageUploadTarget = {
  key: string;
  url: string;
  fields: Record<string, string>;
  method?: "POST";
  expires_in_seconds: number;
};

export async function uploadToStorage(
  target: StorageUploadTarget,
  file: Blob,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const form = new FormData();
  for (const [name, value] of Object.entries(target.fields)) form.append(name, value);
  form.append("file", file);

  const response = await fetchImpl(target.url, { method: "POST", body: form });
  if (!response.ok) {
    throw new Error(`Image upload failed: ${response.status} ${response.statusText}`);
  }
}
