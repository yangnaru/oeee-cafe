use anyhow::Result;
use clap::{Parser, Subcommand};
use oeee_cafe::{
    models::{
        actor::backfill_actors_for_existing_users,
        community::get_communities,
        user::{find_user_by_id, find_user_by_login_name, update_password},
    },
    AppConfig,
};
use std::process::exit;
use uuid::Uuid;

#[derive(Parser)]
#[command(version, about, long_about = None)]
#[command(propagate_version = true)]
struct Cli {
    #[arg(short, long)]
    config: Option<String>,

    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// List all communities
    ListCommunities,
    /// Reset a user's password
    ResetPassword {
        user_id: Uuid,
    },
    /// Get user information by login name
    GetUser {
        login_name: String,
    },
    /// Create actors for existing users that don't have them
    BackfillActors,
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();

    let cfg = AppConfig::new_from_file_and_env(&cli.config.unwrap()).unwrap_or_else(|e| {
        eprintln!("error: {}", e);
        exit(1);
    });

    let mut tx = cfg.connect_database().await.unwrap().begin().await.unwrap();

    // You can check for the existence of subcommands, and if found use their
    // matches just as you would the top level cmd
    match &cli.command {
        Commands::ListCommunities => {
            let communities = get_communities(&mut tx).await?;
            for community in communities {
                println!("Name: {}", community.name);
                println!("Description: {}", community.description);
                println!("Private: {}", community.is_private);
                println!("URL: {}{}", cfg.base_url, community.get_url());
                println!();
            }
        }
        Commands::GetUser { login_name } => {
            let user = find_user_by_login_name(&mut tx, login_name).await;
            match user {
                Ok(Some(user)) => {
                    print_user_info(user);
                }
                Ok(None) => {
                    println!("User not found");
                }
                Err(e) => {
                    eprintln!("error: {}", e);
                    exit(1);
                }
            }
        }
        Commands::ResetPassword { user_id } => {
            let user = find_user_by_id(&mut tx, *user_id).await;
            match user {
                Ok(Some(user)) => {
                    print_user_info(user);
                    println!();
                    let password = rpassword::prompt_password("New password: ").unwrap();
                    let password2 = rpassword::prompt_password("New password (again): ").unwrap();

                    if password != password2 {
                        eprintln!("Passwords do not match");
                        exit(1);
                    }

                    update_password(&mut tx, *user_id, password).await.unwrap();
                    tx.commit().await.unwrap();

                    println!("Password updated");
                }
                Ok(None) => {
                    println!("User not found");
                }
                Err(e) => {
                    eprintln!("error: {}", e);
                    exit(1);
                }
            }
        }
        Commands::BackfillActors => {
            println!("Starting actor backfill for existing users...");
            let created_count = backfill_actors_for_existing_users(&mut tx, &cfg).await?;
            tx.commit().await?;
            println!("✅ Created {} actors for existing users", created_count);
        }
    }

    Ok(())
}

fn print_user_info(user: oeee_cafe::models::user::User) {
    println!("ID: {}", user.id);
    println!("Login Name: {}", user.login_name);
    println!("Display Name: {}", user.display_name);
    println!("Email: {:?}", user.email);
    println!("Preferred Language: {:?}", user.preferred_language);
    println!("Signup Date: {:?}", user.created_at);
}
