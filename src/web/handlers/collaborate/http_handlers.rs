use crate::app_error::AppError;
use crate::models::user::AuthSession;
use crate::web::context::CommonContext;
use crate::web::handlers::{ExtractAcceptLanguage, ExtractFtlLang};
use crate::web::state::AppState;
use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{Html, IntoResponse, Json, Response};
use minijinja::context;
use uuid::Uuid;

use super::db;
use super::types::*;
use super::utils::get_preferred_locale;

pub async fn get_auth_info(
    auth_session: AuthSession,
    ExtractAcceptLanguage(accept_language): ExtractAcceptLanguage,
) -> impl IntoResponse {
    match auth_session.user {
        Some(user) => {
            let preferred_locale =
                get_preferred_locale(user.preferred_language.clone(), &accept_language);

            (
                StatusCode::OK,
                Json(AuthInfo {
                    user_id: user.id.to_string(),
                    login_name: user.login_name,
                    preferred_locale,
                }),
            )
                .into_response()
        }
        None => (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({
                "error": "Authentication required"
            })),
        )
            .into_response(),
    }
}

pub async fn get_collaboration_meta(
    Path(session_uuid): Path<Uuid>,
    auth_session: AuthSession,
    State(state): State<AppState>,
) -> Result<Json<CollaborationMeta>, AppError> {
    let _user = auth_session
        .user
        .ok_or_else(|| anyhow::anyhow!("Authentication required"))?;

    let db = &state.db_pool;

    let session = sqlx::query!(
        r#"
        SELECT cs.title, cs.width, cs.height, cs.owner_id, cs.saved_post_id, cs.max_participants, u.login_name as owner_login_name
        FROM collaborative_sessions cs
        JOIN users u ON cs.owner_id = u.id
        WHERE cs.id = $1 AND cs.ended_at IS NULL
        "#,
        session_uuid
    )
    .fetch_optional(db)
    .await?
    .ok_or_else(|| anyhow::anyhow!("Session not found or not active"))?;

    let user_count = sqlx::query_scalar!(
        r#"
        SELECT COUNT(DISTINCT user_id) as "count!"
        FROM collaborative_sessions_participants
        WHERE session_id = $1 AND is_active = true
        "#,
        session_uuid
    )
    .fetch_one(db)
    .await?;

    Ok(Json(CollaborationMeta {
        title: session
            .title
            .unwrap_or_else(|| "Untitled Collaboration".to_string()),
        width: session.width,
        height: session.height,
        owner_id: session.owner_id.to_string(),
        saved_post_id: session.saved_post_id.map(|id| id.to_string()),
        owner_login_name: session.owner_login_name,
        max_users: session.max_participants,
        current_user_count: user_count,
    }))
}

#[derive(serde::Deserialize)]
pub struct LobbyQuery {
    /// Slug to preselect, so a community page can link straight into the
    /// create form with its own community chosen.
    pub community: Option<String>,
}

pub async fn collaborate_lobby(
    auth_session: AuthSession,
    ExtractFtlLang(ftl_lang): ExtractFtlLang,
    State(state): State<AppState>,
    Query(query): Query<LobbyQuery>,
) -> Result<impl IntoResponse, AppError> {
    // Viewable signed out: the lobby doubles as a public gallery. Creating a
    // session still needs an account, which the template gates.
    let user = auth_session.user;
    let (viewer_user_id, viewer_show_sensitive) = match user.as_ref() {
        Some(user) => (Some(user.id), user.show_sensitive_content),
        None => (None, false),
    };

    let db = &state.db_pool;
    let mut tx = db.begin().await?;

    let common_ctx = CommonContext::build(&mut tx, viewer_user_id).await?;

    let active_sessions = sqlx::query_as!(
        SessionWithCounts,
        r#"
        SELECT
            cs.id,
            u.login_name as owner_login_name,
            cs.title,
            cs.width,
            cs.height,
            cs.created_at,
            cs.max_participants,
            c.name AS "community_name?",
            c.slug AS "community_slug?",
            COALESCE(COUNT(DISTINCT csp.user_id) FILTER (WHERE csp.is_active = true), 0) as participant_count
        FROM collaborative_sessions cs
        JOIN users u ON cs.owner_id = u.id
        LEFT JOIN communities c ON cs.community_id = c.id
        LEFT JOIN collaborative_sessions_participants csp ON cs.id = csp.session_id
        WHERE cs.is_public = true
          AND cs.ended_at IS NULL
          AND (cs.community_id IS NULL OR c.visibility = 'public')
        GROUP BY cs.id, u.login_name, cs.max_participants, c.name, c.slug
        HAVING COALESCE(COUNT(DISTINCT csp.user_id) FILTER (WHERE csp.is_active = true), 0) < cs.max_participants
        ORDER BY cs.last_activity DESC
        LIMIT 20
        "#
    )
    .fetch_all(&mut *tx)
    .await?;

    // Finished collaborative drawings, rendered through the same card template
    // as the home grid. Sensitive posts follow the viewer's preference exactly
    // as they do elsewhere.
    let collaborative_posts = sqlx::query!(
        r#"
        SELECT
            p.id,
            p.title,
            u.login_name AS user_login_name,
            c.slug AS "community_slug?",
            c.name AS "community_name?",
            i.image_filename,
            i.width AS image_width,
            i.height AS image_height,
            (p.is_sensitive OR p.is_explicit) AS "is_sensitive!",
            p.published_at
        FROM collaborative_sessions cs
        JOIN posts p ON cs.saved_post_id = p.id
        JOIN users u ON p.author_id = u.id
        JOIN images i ON p.image_id = i.id
        LEFT JOIN communities c ON p.community_id = c.id
        WHERE p.published_at IS NOT NULL
          AND p.deleted_at IS NULL
          AND (c.visibility = 'public' OR p.community_id IS NULL)
          AND ((p.is_sensitive = false AND p.is_explicit = false)
               OR $1 = true
               OR p.author_id = $2)
        ORDER BY p.published_at DESC
        LIMIT 60
        "#,
        viewer_show_sensitive,
        viewer_user_id,
    )
    .fetch_all(&mut *tx)
    .await?
    .into_iter()
    .map(|row| {
        serde_json::json!({
            "id": row.id.to_string(),
            "title": row.title,
            "user_login_name": row.user_login_name,
            "community_slug": row.community_slug,
            "community_name": row.community_name,
            "image_filename": row.image_filename,
            "image_width": row.image_width,
            "image_height": row.image_height,
            "is_sensitive": row.is_sensitive,
            "published_at": row.published_at,
        })
    })
    .collect::<Vec<_>>();

    // Communities this user may post into. Reuses the rule the "move post"
    // feature already applies — public, unlisted where they have posted,
    // private where they are a member — rather than inventing a second one, so
    // what the picker offers is exactly what create_collaborative_session
    // accepts.
    //
    // Split into three tiers so the ones a user actually draws in are reachable
    // without scrolling past every public community on the site: communities
    // they belong to, then ones they have posted in, then the rest. A member
    // who has also posted appears only in the first tier.
    let mut member_communities: Vec<serde_json::Value> = Vec::new();
    let mut participated_communities: Vec<serde_json::Value> = Vec::new();
    let mut other_communities: Vec<serde_json::Value> = Vec::new();
    if let Some(user_id) = viewer_user_id {
        for community in crate::models::post::get_movable_communities(&mut tx, user_id).await? {
            let entry = serde_json::json!({
                "id": community.id.to_string(),
                "name": community.name,
                "slug": community.slug,
                "description": community.description,
                "owner_login_name": community.owner_login_name,
                "visibility": community.visibility,
            });
            if community.is_member {
                member_communities.push(entry);
            } else if community.has_participated {
                participated_communities.push(entry);
            } else {
                other_communities.push(entry);
            }
        }
    }

    tx.commit().await?;

    let template = state.env.get_template("collaborate_lobby.jinja")?;

    let rendered = template.render(context! {
        current_user => user,
        active_sessions => active_sessions,
        // Shared card fragment contract. The gallery does not paginate, so
        // has_more is fixed false and no sentinel is emitted — otherwise it
        // would point at the home feed's load-more endpoint from this page.
        feed => context! {
            posts => collaborative_posts,
            has_more => false,
            next_url => "",
        },
        // Three tiers rather than one flat list; the template renders them as
        // optgroups in that order.
        has_postable_communities => !member_communities.is_empty()
            || !participated_communities.is_empty()
            || !other_communities.is_empty(),
        member_communities => member_communities,
        participated_communities => participated_communities,
        other_communities => other_communities,
        selected_community_slug => query.community,
        r2_public_endpoint_url => state.config.r2_public_endpoint_url.clone(),
        canvas_sizes => vec![
            ("300x300", "300×300"),
            ("1024x768", "1024×768"),
        ],
        draft_post_count => common_ctx.draft_post_count,
        unread_notification_count => common_ctx.unread_notification_count,
        ftl_lang
    })?;

    Ok(Html(rendered).into_response())
}

pub async fn create_collaborative_session(
    auth_session: AuthSession,
    State(state): State<AppState>,
    Json(request): Json<CreateSessionRequest>,
) -> Result<Json<CreateSessionResponse>, AppError> {
    let user = auth_session
        .user
        .ok_or_else(|| anyhow::anyhow!("Authentication required"))?;

    let db = &state.db_pool;
    let mut tx = db.begin().await?;

    // Parse community_id if provided, otherwise None for personal collaborative sessions
    let community_id = request
        .community_id
        .as_ref()
        .filter(|id| !id.is_empty())
        .and_then(|id| id.parse::<Uuid>().ok());

    // A saved session becomes a post in this community, so the same rule that
    // governs posting has to apply here. Without this any id was accepted,
    // which would put a drawing into a private community the caller is not a
    // member of.
    if let Some(community_id) = community_id {
        let allowed = crate::models::post::get_movable_communities(&mut tx, user.id)
            .await?
            .into_iter()
            .any(|community| community.id == community_id);
        if !allowed {
            return Err(AppError::Forbidden);
        }
    }

    let session_id = Uuid::new_v4();
    sqlx::query!(
        r#"
        INSERT INTO collaborative_sessions
        (id, owner_id, title, width, height, is_public, community_id, max_participants)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        "#,
        session_id,
        user.id,
        request.title,
        request.width,
        request.height,
        request.is_public,
        community_id,
        request.max_participants
    )
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    Ok(Json(CreateSessionResponse {
        session_id: session_id.to_string(),
        url: format!("/collaborate/{}", session_id),
    }))
}

pub async fn save_collaborative_session(
    Path(session_uuid): Path<Uuid>,
    auth_session: AuthSession,
    State(state): State<AppState>,
    body: Bytes,
) -> Result<Json<SaveSessionResponse>, AppError> {
    let user = auth_session
        .user
        .ok_or_else(|| anyhow::anyhow!("Authentication required"))?;

    let db = &state.db_pool;

    let session = sqlx::query!(
        r#"
        SELECT owner_id, saved_post_id, u.login_name as owner_login_name 
        FROM collaborative_sessions cs
        JOIN users u ON cs.owner_id = u.id
        WHERE cs.id = $1
        "#,
        session_uuid
    )
    .fetch_optional(db)
    .await?
    .ok_or_else(|| anyhow::anyhow!("Session not found"))?;

    if session.owner_id != user.id {
        return Err(anyhow::anyhow!("Only session owner can save").into());
    }

    if session.saved_post_id.is_some() {
        return Err(anyhow::anyhow!("Session has already been saved").into());
    }

    let png_data = body.to_vec();

    let (post_id, owner_login_name) =
        db::save_session_to_post(db.clone(), session_uuid, user.id, png_data, state.clone())
            .await
            .map_err(|e| anyhow::anyhow!("Save failed: {}", e))?;

    let post_url = format!("/@{}/{}", owner_login_name, post_id);

    // Note: Session ending and participant notification will be handled by the WebSocket END_SESSION message
    // that the client sends after receiving this HTTP response. This prevents double-broadcasting.

    Ok(Json(SaveSessionResponse {
        post_id: post_id.to_string(),
        owner_login_name,
        post_url,
    }))
}

pub async fn serve_collaborative_app() -> Result<Response, AppError> {
    let html = std::fs::read_to_string("neo-cucumber/dist/index.html")
        .map_err(|_| anyhow::anyhow!("Failed to load collaborative app"))?;
    Ok(Html(html).into_response())
}

pub async fn get_active_sessions_json(
    auth_session: AuthSession,
    State(state): State<AppState>,
) -> Result<Json<Vec<SessionWithCounts>>, AppError> {
    let _user = match auth_session.user {
        Some(user) => user,
        None => return Err(anyhow::anyhow!("Authentication required").into()),
    };

    let db = &state.db_pool;

    let active_sessions = sqlx::query_as!(
        SessionWithCounts,
        r#"
        SELECT
            cs.id,
            u.login_name as owner_login_name,
            cs.title,
            cs.width,
            cs.height,
            cs.created_at,
            cs.max_participants,
            c.name AS "community_name?",
            c.slug AS "community_slug?",
            COALESCE(COUNT(DISTINCT csp.user_id) FILTER (WHERE csp.is_active = true), 0) as participant_count
        FROM collaborative_sessions cs
        JOIN users u ON cs.owner_id = u.id
        LEFT JOIN communities c ON cs.community_id = c.id
        LEFT JOIN collaborative_sessions_participants csp ON cs.id = csp.session_id
        WHERE cs.is_public = true
          AND cs.ended_at IS NULL
          AND (cs.community_id IS NULL OR c.visibility = 'public')
        GROUP BY cs.id, u.login_name, cs.max_participants, c.name, c.slug
        HAVING COALESCE(COUNT(DISTINCT csp.user_id) FILTER (WHERE csp.is_active = true), 0) < cs.max_participants
        ORDER BY cs.last_activity DESC
        LIMIT 20
        "#
    )
    .fetch_all(db)
    .await?;

    Ok(Json(active_sessions))
}


#[cfg(test)]
mod tests {
    use crate::web::handlers::test_support;
    use minijinja::context;
    use serde_json::json;

    fn sample_community(id: &str, name: &str, slug: &str, visibility: &str) -> serde_json::Value {
        json!({
            "id": id,
            "name": name,
            "slug": slug,
            "description": "",
            "owner_login_name": "owner",
            "visibility": visibility,
        })
    }

    fn lobby_context(signed_in: bool, posts: Vec<serde_json::Value>) -> minijinja::Value {
        lobby_context_with_sessions(signed_in, posts, Vec::new())
    }

    fn lobby_context_with_sessions(
        signed_in: bool,
        posts: Vec<serde_json::Value>,
        active_sessions: Vec<serde_json::Value>,
    ) -> minijinja::Value {
        let community = |id, name, slug, visibility| {
            if signed_in {
                vec![sample_community(id, name, slug, visibility)]
            } else {
                vec![]
            }
        };
        let members = community(
            "00000000-0000-0000-0000-000000000003",
            "Private Club",
            "club",
            "private",
        );
        let participated = community(
            "00000000-0000-0000-0000-000000000004",
            "Open Studio",
            "open",
            "public",
        );
        let others = community(
            "00000000-0000-0000-0000-000000000005",
            "Somewhere Else",
            "elsewhere",
            "public",
        );
        context! {
            current_user => if signed_in {
                json!({"login_name": "someone", "email_verified_at": "2026-01-01T00:00:00Z"})
            } else {
                json!(null)
            },
            active_sessions => active_sessions,
            feed => context! {
                posts => posts,
                has_more => false,
                next_url => "",
            },
            canvas_sizes => vec![("300x300", "300x300")],
            has_postable_communities => signed_in,
            member_communities => members,
            participated_communities => participated,
            other_communities => others,
            selected_community_slug => "open",
            draft_post_count => 0,
            unread_notification_count => 0,
            ftl_lang => "en",
        }
    }

    fn sample_post() -> serde_json::Value {
        json!({
            "id": "00000000-0000-0000-0000-000000000001",
            "title": "Together",
            "user_login_name": "someone",
            "community_slug": "open",
            "community_name": "Open Studio",
            "image_filename": "abcdef.png",
            "image_width": 300,
            "image_height": 300,
            "is_sensitive": false,
            "published_at": "2026-01-02T03:04:05Z",
        })
    }

    #[test]
    fn lobby_renders_signed_out_without_the_create_form() {
        let env = test_support::env();
        let template = env
            .get_template("collaborate_lobby.jinja")
            .expect("template loads");
        let rendered = template
            .render(lobby_context(false, vec![sample_post()]))
            .expect("renders signed out");
        assert!(!rendered.contains("create-session-form"));
        assert!(rendered.contains("collaborate-sign-in-to-create"));
        // The gallery is the reason signed-out visitors can reach this page.
        assert!(rendered.contains("posts-grid-item"));
    }

    #[test]
    fn create_form_preselects_the_linked_community() {
        // A community page links here with ?community=<slug>; the option for
        // that community must come back selected, or the saved drawing would
        // land nowhere.
        let env = test_support::env();
        let template = env
            .get_template("collaborate_lobby.jinja")
            .expect("template loads");
        let rendered = template
            .render(lobby_context(true, vec![]))
            .expect("renders signed in");
        assert!(rendered.contains("name=\"community_id\""));
        assert!(rendered.contains("collaborate-community-none"));
        assert!(
            rendered.contains("selected"),
            "linked community was not preselected"
        );
    }

    #[test]
    fn lobby_omits_the_live_sessions_section_when_there_are_none() {
        // No empty-state message: with zero live sessions the section is simply
        // absent rather than announcing its own emptiness.
        let env = test_support::env();
        let template = env
            .get_template("collaborate_lobby.jinja")
            .expect("template loads");
        let rendered = template
            .render(lobby_context(false, vec![sample_post()]))
            .expect("renders");
        assert!(!rendered.contains("collaborate-active-sessions"));
        assert!(!rendered.contains("no-sessions"));
        // ...while the gallery still renders.
        assert!(rendered.contains("posts-grid-item"));
    }

    #[test]
    fn lobby_shows_the_create_form_when_signed_in() {
        let env = test_support::env();
        let template = env
            .get_template("collaborate_lobby.jinja")
            .expect("template loads");
        let rendered = template
            .render(lobby_context(true, vec![]))
            .expect("renders signed in");
        assert!(rendered.contains("create-session-form"));
    }

    #[test]
    fn community_picker_ranks_membership_above_participation() {
        // The whole point of the tiers: a user with a hundred public
        // communities in the list still finds their own without scrolling.
        let env = test_support::env();
        let template = env
            .get_template("collaborate_lobby.jinja")
            .expect("template loads");
        let rendered = template
            .render(lobby_context(true, vec![]))
            .expect("renders signed in");
        let yours = rendered
            .find("collaborate-community-group-yours")
            .expect("member group rendered");
        let participated = rendered
            .find("collaborate-community-group-participated")
            .expect("participated group rendered");
        let public = rendered
            .find("collaborate-community-group-public")
            .expect("public group rendered");
        assert!(yours < participated && participated < public, "tiers out of order");
        // Non-public tiers say so in the option text, because a saved drawing
        // landing somewhere nobody can see it is a surprise worth preventing.
        assert!(rendered.contains("community-badge-private"));
    }

    #[test]
    fn community_picker_ships_the_filter_and_its_search_keys() {
        let env = test_support::env();
        let template = env
            .get_template("collaborate_lobby.jinja")
            .expect("template loads");
        let rendered = template
            .render(lobby_context(true, vec![]))
            .expect("renders signed in");
        assert!(rendered.contains("id=\"community-filter\""));
        // Hidden until the script unhides it: without JS the select alone still
        // works, and a dead search box would be worse than none.
        assert!(rendered.contains("hidden"));
        // Owner handle and slug are matchable, not just the display name.
        assert!(rendered.contains("data-search=\"open studio open @owner"));
    }

    #[test]
    fn lobby_gallery_carries_the_shared_density_control() {
        // Same control, grid id and head fragment as / and /home, so the
        // stored column count applies here too.
        let env = test_support::env();
        let template = env
            .get_template("collaborate_lobby.jinja")
            .expect("template loads");
        let rendered = template
            .render(lobby_context(false, vec![sample_post()]))
            .expect("renders");
        assert!(rendered.contains("id=\"post-cols\""));
        assert!(rendered.contains("id=\"post-feed-grid\""));
        assert!(rendered.contains("--page-width: 1600px"));
        assert!(rendered.contains("class=\"feed-header\""));
    }

    #[test]
    fn session_cards_show_seats_and_destination_community() {
        let env = test_support::env();
        let template = env
            .get_template("collaborate_lobby.jinja")
            .expect("template loads");
        let rendered = template
            .render(lobby_context_with_sessions(
                false,
                vec![],
                vec![json!({
                    "id": "00000000-0000-0000-0000-000000000009",
                    "owner_login_name": "someone",
                    "title": "Doodle",
                    "width": 300,
                    "height": 300,
                    "created_at": "2026-01-02T03:04:05",
                    "participant_count": 2,
                    "max_participants": 4,
                    "community_name": "Open Studio",
                    "community_slug": "open",
                })],
            ))
            .expect("renders");
        assert!(rendered.contains("2 / 4"));
        assert!(rendered.contains("/communities/@open"));
        assert!(rendered.contains("Open Studio"));
    }

    #[test]
    fn session_cards_omit_the_community_line_for_personal_sessions() {
        let env = test_support::env();
        let template = env
            .get_template("collaborate_lobby.jinja")
            .expect("template loads");
        let rendered = template
            .render(lobby_context_with_sessions(
                false,
                vec![],
                vec![json!({
                    "id": "00000000-0000-0000-0000-000000000009",
                    "owner_login_name": "someone",
                    "title": "Doodle",
                    "width": 300,
                    "height": 300,
                    "created_at": "2026-01-02T03:04:05",
                    "participant_count": 1,
                    "max_participants": 2,
                    "community_name": json!(null),
                    "community_slug": json!(null),
                })],
            ))
            .expect("renders");
        // The class also appears in the page's <style> block, so match the tag.
        assert!(!rendered.contains("<p class=\"session-community\">"));
    }

    #[test]
    fn lobby_gallery_reuses_the_home_card_and_omits_the_sentinel() {
        // has_more is false, so the shared fragment must not emit a sentinel
        // pointing at /api/home/posts from this page.
        let env = test_support::env();
        let template = env
            .get_template("collaborate_lobby.jinja")
            .expect("template loads");
        let rendered = template
            .render(lobby_context(false, vec![sample_post()]))
            .expect("renders");
        assert!(rendered.contains("post-card-byline"));
        assert!(!rendered.contains("infinite-scroll-sentinel"));
    }
}
