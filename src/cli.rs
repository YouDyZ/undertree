//! `undertree user ...` admin commands (docs/API.md → Admin CLI).

use clap::Subcommand;
use sqlx::SqlitePool;

type Result<T = ()> = std::result::Result<T, Box<dyn std::error::Error>>;

#[derive(Subcommand)]
pub enum UserCmd {
    /// Register a user for OAuth login (needs --email and/or --github)
    Add {
        username: String,
        #[arg(long)]
        display_name: Option<String>,
        /// Also used to match Google logins (must be the verified Google address)
        #[arg(long)]
        email: Option<String>,
        /// GitHub login to allow GitHub OAuth for this user
        #[arg(long)]
        github: Option<String>,
        #[arg(long)]
        admin: bool,
    },
    /// List users
    List,
    /// Remove a user (their sessions stop working immediately; open editor sockets end at the next reconnect)
    Remove { username: String },
}

pub async fn run(db: &SqlitePool, cmd: UserCmd) -> Result {
    match cmd {
        UserCmd::Add {
            username,
            display_name,
            email,
            github,
            admin,
        } => {
            if email.is_none() && github.is_none() {
                return Err("user needs --email (Google) and/or --github to log in".into());
            }
            sqlx::query(
                "INSERT INTO users (username, display_name, email, github_login, is_admin)
                 VALUES (?, ?, ?, ?, ?)",
            )
            .bind(&username)
            .bind(display_name.as_deref().unwrap_or(&username))
            .bind(email)
            .bind(github)
            .bind(admin)
            .execute(db)
            .await?;
            println!("added {username}");
        }
        UserCmd::List => {
            let rows: Vec<String> = sqlx::query_scalar(
                "SELECT username || char(9) || display_name || char(9) || ifnull(email, '') || char(9)
                     || ifnull(github_login, '') || char(9) || iif(is_admin, 'yes', 'no')
                 FROM users ORDER BY username",
            )
            .fetch_all(db)
            .await?;
            println!("USERNAME\tDISPLAY NAME\tEMAIL\tGITHUB\tADMIN");
            for row in rows {
                println!("{row}");
            }
        }
        UserCmd::Remove { username } => {
            let mut tx = db.begin().await?;
            // same rule as the API: a project must keep an owner (`project_members.role`)
            let sole: i64 = sqlx::query_scalar(
                "SELECT count(*) FROM project_members m JOIN users u ON u.id = m.user_id
                 WHERE u.username = ?1 AND m.role = 'owner'
                   AND NOT EXISTS (SELECT 1 FROM project_members o WHERE o.project_id = m.project_id
                                     AND o.role = 'owner' AND o.user_id != m.user_id)",
            )
            .bind(&username)
            .fetch_one(&mut *tx)
            .await?;
            if sole > 0 {
                return Err(format!(
                    "{username} is the last owner of {sole} project(s): delete the user in the \
                     admin UI (transfers them to you) or make someone else owner first"
                )
                .into());
            }
            // `owner_id` (creator, ON DELETE RESTRICT) moves to another owner
            sqlx::query(
                "UPDATE projects SET owner_id = (SELECT m.user_id FROM project_members m
                     WHERE m.project_id = projects.id AND m.role = 'owner' AND m.user_id != projects.owner_id
                     LIMIT 1)
                 WHERE owner_id = (SELECT id FROM users WHERE username = ?1)",
            )
            .bind(&username)
            .execute(&mut *tx)
            .await?;
            let n = sqlx::query("DELETE FROM users WHERE username = ?")
                .bind(&username)
                .execute(&mut *tx)
                .await?
                .rows_affected();
            if n == 0 {
                return Err(format!("no such user: {username}").into());
            }
            tx.commit().await?;
            println!("removed {username}");
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn remove_keeps_every_project_owned() {
        let db = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::migrate!().run(&db).await.unwrap();
        for sql in [
            "INSERT INTO users (id, username, display_name) VALUES (1, 'a', 'A'), (2, 'b', 'B')",
            "INSERT INTO projects (id, name, remote_url, branch, owner_id)
             VALUES (1, 'P', 'git@h:p', 'main', 1)",
            "INSERT INTO project_members (project_id, user_id, role)
             VALUES (1, 1, 'owner'), (1, 2, 'editor')",
        ] {
            sqlx::query(sql).execute(&db).await.unwrap();
        }
        let rm = |u: &str| run(&db, UserCmd::Remove { username: u.into() });
        // creator and sole owner
        assert!(rm("a")
            .await
            .unwrap_err()
            .to_string()
            .contains("last owner"));
        // a plain editor may go
        rm("b").await.unwrap();
        sqlx::query("INSERT INTO users (id, username, display_name) VALUES (3, 'c', 'C')")
            .execute(&db)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO project_members (project_id, user_id, role) VALUES (1, 3, 'owner')",
        )
        .execute(&db)
        .await
        .unwrap();
        // the creator is not the last owner any more: `owner_id` moves on
        rm("a").await.unwrap();
        let owner: i64 = sqlx::query_scalar("SELECT owner_id FROM projects WHERE id = 1")
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(owner, 3);
    }
}
