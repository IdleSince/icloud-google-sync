# secrets/

This folder holds the Docker secrets. **Nothing in here except this README is ever committed**
(see `.gitignore`). Each file contains exactly one value, no trailing spaces.

| File | Content | How to create |
|---|---|---|
| `app_encryption_key` | 32 random bytes, base64 | `openssl rand -base64 32 \| tr '+/' '-_' > secrets/app_encryption_key` (or `python3 -c "import os,base64;print(base64.urlsafe_b64encode(os.urandom(32)).decode())"`) |
| `admin_password` | Password for the web UI login | `openssl rand -base64 24 > secrets/admin_password` (then store it in your password manager) |
| `google_client_id` | OAuth client ID from Google Cloud | copy from the Google Cloud console |
| `google_client_secret` | OAuth client secret | copy from the Google Cloud console |

The container runs as UID 10001 and must be able to read the files:

```sh
chmod 400 secrets/*  && sudo chown 10001:10001 secrets/app_encryption_key secrets/admin_password secrets/google_client_id secrets/google_client_secret
```

> Losing `app_encryption_key` means the stored iCloud app password and Google token can no
> longer be decrypted. Back it up together with the data volume (see README, "Backup").
