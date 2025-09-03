# oeee-cafe

## Main Rust server (`./src`)

When running cargo commands, use the environment variable `DATABASE_URL=postgresql:///oeee_cafe`.

When creating SQLx migrations, use the command `sqlx migrate add`.

## neo-cucumber (`./neo-cucumber`)

When extracting and compiling Lingui locales, use these commands:

```bash
pnpm run extract
pnpm run compile
```
