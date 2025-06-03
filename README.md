# oeee-cafe

## Development

```
$ cargo install cargo-watch
$ DATABASE_URL=postgresql:///oeee_cafe cargo watch -- cargo run config/dev.toml
```

## Migration

```
$ cargo install sqlx-cli
$ DATABASE_URL=postgresql:///oeee_cafe sqlx migrate run
```
