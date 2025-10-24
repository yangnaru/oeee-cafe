use crate::app_error::AppError;
use crate::models::banner::{create_banner, BannerDraft};
use crate::models::community::find_community_by_id;
use crate::models::post::{create_post, find_post_by_id, PostDraft, Tool};
use crate::models::user::AuthSession;
use crate::web::context::CommonContext;
use crate::web::handlers::ExtractFtlLang;
use crate::web::state::AppState;
use aws_sdk_s3::config::{Credentials as AwsCredentials, Region, SharedCredentialsProvider};
use aws_sdk_s3::error::SdkError;
use aws_sdk_s3::operation::put_object::{PutObjectError, PutObjectOutput};
use aws_sdk_s3::primitives::ByteStream;
use aws_sdk_s3::Client;
use axum::response::{IntoResponse, Redirect};
use axum::Json;
use axum::{
    extract::{Multipart, State},
    http::StatusCode,
    response::Html,
    Form,
};
use chrono::Duration;
use data_encoding::BASE64;
use data_url::DataUrl;
use hex::decode;
use minijinja::context;
use serde::{Deserialize, Serialize};
use sha256::digest;
use sqlx::postgres::types::PgInterval;
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

#[derive(Deserialize, Debug)]
#[allow(dead_code)]
pub struct Input {
    width: String,
    height: String,
    tool: String,
    community_id: String,
    parent_post_id: Option<String>,
}

pub async fn start_draw_get() -> Redirect {
    Redirect::to("/")
}

pub async fn start_draw(
    auth_session: AuthSession,
    State(state): State<AppState>,
    ExtractFtlLang(ftl_lang): ExtractFtlLang,
    Form(input): Form<Input>,
) -> Result<Html<String>, AppError> {
    let template_filename = match input.tool.as_str() {
        "neo" => "draw_post_neo.jinja",
        "tegaki" => "draw_post_tegaki.jinja",
        _ => "draw_post_neo.jinja",
    };

    let db = &state.db_pool;
    let mut tx = db.begin().await?;

    let common_ctx =
        CommonContext::build(&mut tx, auth_session.user.as_ref().map(|u| u.id)).await?;

    let community_id = Uuid::parse_str(&input.community_id).unwrap();
    let community = find_community_by_id(&mut tx, community_id).await?.unwrap();

    // Query parent post if parent_post_id is provided
    let parent_post = if let Some(ref parent_post_id) = input.parent_post_id {
        let parent_uuid = Uuid::parse_str(parent_post_id).ok();
        if let Some(uuid) = parent_uuid {
            find_post_by_id(&mut tx, uuid).await?
        } else {
            None
        }
    } else {
        None
    };

    let template: minijinja::Template<'_, '_> = state.env.get_template(template_filename)?;
    let rendered = template.render(context! {
        current_user => auth_session.user,
        default_community_id => state.config.default_community_id.clone(),
        community_name => community.name,
        tool => input.tool,
        width => input.width.parse::<u32>()?,
        height => input.height.parse::<u32>()?,
        background_color => community.background_color,
        foreground_color => community.foreground_color,
        community_id => input.community_id,
        community_slug => community.slug,
        parent_post => parent_post,
        parent_post_id => input.parent_post_id,
        draft_post_count => common_ctx.draft_post_count,
        unread_notification_count => common_ctx.unread_notification_count,
        ftl_lang
    })?;

    Ok(Html(rendered))
}

pub async fn upload_object(
    client: &Client,
    bucket_name: &str,
    bytes: Vec<u8>,
    key: &str,
    checksum_sha256: &str,
) -> Result<PutObjectOutput, SdkError<PutObjectError>> {
    let body = ByteStream::from(bytes);
    client
        .put_object()
        .bucket(bucket_name)
        .key(key)
        .checksum_sha256(checksum_sha256)
        .body(body)
        .send()
        .await
}

#[derive(Serialize)]
pub struct DrawFinishResponse {
    pub community_id: String,
    pub post_id: String,
}

pub async fn draw_finish(
    auth_session: AuthSession,
    State(state): State<AppState>,
    mut multipart: Multipart,
) -> Result<impl IntoResponse, AppError> {
    let credentials: AwsCredentials = AwsCredentials::new(
        state.config.aws_access_key_id.clone(),
        state.config.aws_secret_access_key.clone(),
        None,
        None,
        "",
    );
    let credentials_provider = SharedCredentialsProvider::new(credentials);
    let config = aws_sdk_s3::Config::builder()
        .endpoint_url(state.config.r2_endpoint_url.clone())
        .region(Region::new(state.config.aws_region.clone()))
        .credentials_provider(credentials_provider)
        .behavior_version_latest()
        .build();
    let client = Client::from_conf(config);

    let mut width = 0;
    let mut height = 0;
    let mut image_sha256 = String::new();
    let mut replay_sha256 = String::new();
    let mut replay_data = Vec::new();
    let mut community_id = Uuid::nil();
    let mut security_timer = 0;
    let mut security_count = 0;
    let mut tool = String::new();
    let mut parent_post_id = None;

    while let Some(field) = multipart.next_field().await.unwrap() {
        let name = field.name().unwrap().to_string();
        let data = field.bytes().await.unwrap();

        if name == "image" {
            let url = DataUrl::process(std::str::from_utf8(data.as_ref()).unwrap()).unwrap();
            let (body, _fragment) = url.decode_to_vec().unwrap();
            image_sha256 = digest(&body);

            assert_eq!(url.mime_type().type_, "image");
            assert_eq!(url.mime_type().subtype, "png");

            upload_object(
                &client,
                &state.config.aws_s3_bucket,
                body,
                &format!(
                    "image/{}{}/{}.png",
                    image_sha256.chars().next().unwrap(),
                    image_sha256.chars().nth(1).unwrap(),
                    image_sha256
                ),
                &BASE64.encode(&decode(image_sha256.clone()).unwrap()),
            )
            .await?;
        } else if name == "animation" {
            replay_sha256 = digest(&*data);
            replay_data = data.to_vec();
        } else if name == "community_id" {
            community_id = Uuid::parse_str(std::str::from_utf8(data.as_ref()).unwrap()).unwrap();
        } else if name == "security_timer" {
            security_timer = std::str::from_utf8(data.as_ref())
                .unwrap()
                .parse::<u128>()
                .unwrap();
        } else if name == "security_count" {
            security_count = std::str::from_utf8(data.as_ref())
                .unwrap()
                .parse::<i32>()
                .unwrap();
        } else if name == "width" {
            width = std::str::from_utf8(data.as_ref())
                .unwrap()
                .parse::<i32>()
                .unwrap();
        } else if name == "height" {
            height = std::str::from_utf8(data.as_ref())
                .unwrap()
                .parse::<i32>()
                .unwrap();
        } else if name == "tool" {
            tool = std::str::from_utf8(data.as_ref()).unwrap().to_string();
        } else if name == "parent_post_id" && !data.is_empty() {
            parent_post_id =
                Some(Uuid::parse_str(std::str::from_utf8(data.as_ref()).unwrap()).unwrap());
        }
    }
    let start = SystemTime::now();
    let since_the_epoch = start
        .duration_since(UNIX_EPOCH)
        .expect("Time went backwards");
    let duration_ms = since_the_epoch.as_millis() - security_timer;

    if tool == "neo" || tool == "cucumber" || tool == "neo-cucumber-offline" {
        upload_object(
            &client,
            &state.config.aws_s3_bucket,
            replay_data,
            &format!(
                "replay/{}{}/{}.pch",
                replay_sha256.chars().next().unwrap(),
                replay_sha256.chars().nth(1).unwrap(),
                replay_sha256
            ),
            &BASE64.encode(&decode(replay_sha256.clone()).unwrap()),
        )
        .await?;
    } else if tool == "tegaki" {
        upload_object(
            &client,
            &state.config.aws_s3_bucket,
            replay_data,
            &format!(
                "replay/{}{}/{}.tgkr",
                replay_sha256.chars().next().unwrap(),
                replay_sha256.chars().nth(1).unwrap(),
                replay_sha256
            ),
            &BASE64.encode(&decode(replay_sha256.clone()).unwrap()),
        )
        .await?;
    } else {
        return Ok(StatusCode::BAD_REQUEST.into_response());
    }

    let replay_filename = if tool == "neo" || tool == "cucumber" || tool == "neo-cucumber-offline" {
        format!("{}.pch", replay_sha256)
    } else if tool == "tegaki" {
        format!("{}.tgkr", replay_sha256)
    } else {
        return Ok(StatusCode::BAD_REQUEST.into_response());
    };

    let tool_enum: Tool = match tool.as_str() {
        "neo" => Tool::Neo,
        "tegaki" => Tool::Tegaki,
        "cucumber" => Tool::Cucumber,
        "neo-cucumber-offline" => Tool::Cucumber,
        _ => return Ok(StatusCode::BAD_REQUEST.into_response()),
    };
    let post_draft = PostDraft {
        author_id: auth_session.user.unwrap().id,
        community_id,
        paint_duration: PgInterval::try_from(
            Duration::try_milliseconds(duration_ms as i64).unwrap_or_default(),
        )
        .unwrap_or_default(),
        stroke_count: security_count,
        width,
        height,
        image_filename: format!("{}.png", image_sha256),
        replay_filename: Some(replay_filename),
        tool: tool_enum,
        parent_post_id,
    };

    let db = &state.db_pool;
    let mut tx = db.begin().await?;
    let post = create_post(&mut tx, post_draft).await?;
    let _ = tx.commit().await;

    Ok(Json(DrawFinishResponse {
        community_id: community_id.to_string(),
        post_id: post.id.to_string(),
    })
    .into_response())
}

pub async fn banner_draw_finish(
    auth_session: AuthSession,
    State(state): State<AppState>,
    mut multipart: Multipart,
) -> Result<Json<BannerDrawFinishResponse>, AppError> {
    let credentials: AwsCredentials = AwsCredentials::new(
        state.config.aws_access_key_id.clone(),
        state.config.aws_secret_access_key.clone(),
        None,
        None,
        "",
    );
    let credentials_provider = SharedCredentialsProvider::new(credentials);
    let config = aws_sdk_s3::Config::builder()
        .endpoint_url(state.config.r2_endpoint_url.clone())
        .region(Region::new(state.config.aws_region.clone()))
        .credentials_provider(credentials_provider)
        .behavior_version_latest()
        .build();
    let client = Client::from_conf(config);

    let mut width = 0;
    let mut height = 0;
    let mut image_sha256 = String::new();
    let mut replay_sha256 = String::new();
    let mut security_timer = 0;
    let mut security_count = 0;

    while let Some(field) = multipart.next_field().await.unwrap() {
        let name = field.name().unwrap().to_string();
        let data = field.bytes().await.unwrap();

        if name == "image" {
            let url = DataUrl::process(std::str::from_utf8(data.as_ref()).unwrap()).unwrap();
            let (body, _fragment) = url.decode_to_vec().unwrap();
            image_sha256 = digest(&body);

            assert_eq!(url.mime_type().type_, "image");
            assert_eq!(url.mime_type().subtype, "png");

            upload_object(
                &client,
                &state.config.aws_s3_bucket,
                body,
                &format!(
                    "image/{}{}/{}.png",
                    image_sha256.chars().next().unwrap(),
                    image_sha256.chars().nth(1).unwrap(),
                    image_sha256
                ),
                &BASE64.encode(&decode(image_sha256.clone()).unwrap()),
            )
            .await?;
        } else if name == "animation" {
            replay_sha256 = digest(&*data);

            upload_object(
                &client,
                &state.config.aws_s3_bucket,
                data.to_vec(),
                &format!(
                    "replay/{}{}/{}.pch",
                    replay_sha256.chars().next().unwrap(),
                    replay_sha256.chars().nth(1).unwrap(),
                    replay_sha256
                ),
                &BASE64.encode(&decode(replay_sha256.clone()).unwrap()),
            )
            .await?;
        } else if name == "security_timer" {
            security_timer = std::str::from_utf8(data.as_ref())
                .unwrap()
                .parse::<u128>()
                .unwrap();
        } else if name == "security_count" {
            security_count = std::str::from_utf8(data.as_ref())
                .unwrap()
                .parse::<i32>()
                .unwrap();
        } else if name == "width" {
            width = std::str::from_utf8(data.as_ref())
                .unwrap()
                .parse::<i32>()
                .unwrap();
        } else if name == "height" {
            height = std::str::from_utf8(data.as_ref())
                .unwrap()
                .parse::<i32>()
                .unwrap();
        }
    }
    let start = SystemTime::now();
    let since_the_epoch = start
        .duration_since(UNIX_EPOCH)
        .expect("Time went backwards");
    let duration_ms = since_the_epoch.as_millis() - security_timer;

    let banner_draft = BannerDraft {
        author_id: auth_session.user.unwrap().id,
        paint_duration: PgInterval::try_from(
            Duration::try_milliseconds(duration_ms as i64).unwrap_or_default(),
        )
        .unwrap_or_default(),
        stroke_count: security_count,
        width,
        height,
        image_filename: format!("{}.png", image_sha256),
        replay_filename: Some(format!("{}.pch", replay_sha256)),
    };

    let db = &state.db_pool;
    let mut tx = db.begin().await?;
    let banner = create_banner(&mut tx, banner_draft).await?;
    let _ = tx.commit().await;

    Ok(Json(BannerDrawFinishResponse {
        banner_id: banner.id.to_string(),
    }))
}

#[derive(Serialize)]
pub struct BannerDrawFinishResponse {
    pub banner_id: String,
}

pub async fn start_banner_draw(
    auth_session: AuthSession,
    ExtractFtlLang(ftl_lang): ExtractFtlLang,
    State(state): State<AppState>,
) -> Result<Html<String>, AppError> {
    let template: minijinja::Template<'_, '_> = state.env.get_template("draw_banner.jinja")?;
    let rendered = template.render(context! {
        width => 200,
        height => 40,
        current_user => auth_session.user,
        ftl_lang,
    })?;

    Ok(Html(rendered))
}
