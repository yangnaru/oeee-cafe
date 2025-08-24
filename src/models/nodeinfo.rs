use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Deserialize, Serialize)]
pub struct NodeInfoWellKnown {
    pub links: Vec<NodeInfoLink>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct NodeInfoLink {
    pub rel: String,
    pub href: String,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct NodeInfo {
    pub version: String,
    pub software: NodeInfoSoftware,
    pub protocols: Vec<String>,
    pub usage: HashMap<String, serde_json::Value>,
    #[serde(rename = "openRegistrations")]
    pub open_registrations: Option<bool>,
    pub metadata: Option<HashMap<String, serde_json::Value>>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct NodeInfoSoftware {
    pub name: String,
    pub version: String,
    pub repository: Option<String>,
}

pub async fn fetch_nodeinfo(host: &str) -> Result<Option<NodeInfo>> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()?;

    // First, try to get the well-known nodeinfo
    let well_known_url = format!("https://{}/.well-known/nodeinfo", host);
    
    let well_known_response = match client.get(&well_known_url).send().await {
        Ok(response) => {
            if response.status().is_success() {
                response
            } else {
                tracing::debug!("Well-known nodeinfo not found for {}: {}", host, response.status());
                return Ok(None);
            }
        }
        Err(e) => {
            tracing::debug!("Failed to fetch well-known nodeinfo for {}: {}", host, e);
            return Ok(None);
        }
    };

    let well_known: NodeInfoWellKnown = match well_known_response.json().await {
        Ok(data) => data,
        Err(e) => {
            tracing::debug!("Failed to parse well-known nodeinfo for {}: {}", host, e);
            return Ok(None);
        }
    };

    // Find the nodeinfo 2.0 or 2.1 link (prefer 2.1 if available)
    let nodeinfo_url = well_known
        .links
        .iter()
        .find(|link| link.rel == "http://nodeinfo.diaspora.software/ns/schema/2.1")
        .or_else(|| {
            well_known
                .links
                .iter()
                .find(|link| link.rel == "http://nodeinfo.diaspora.software/ns/schema/2.0")
        })
        .map(|link| &link.href);

    let nodeinfo_url = match nodeinfo_url {
        Some(url) => url,
        None => {
            tracing::debug!("No supported nodeinfo schema found for {}", host);
            return Ok(None);
        }
    };

    // Fetch the actual nodeinfo
    let nodeinfo_response = match client.get(nodeinfo_url).send().await {
        Ok(response) => {
            if response.status().is_success() {
                response
            } else {
                tracing::debug!("Nodeinfo not found at {} for {}: {}", nodeinfo_url, host, response.status());
                return Ok(None);
            }
        }
        Err(e) => {
            tracing::debug!("Failed to fetch nodeinfo at {} for {}: {}", nodeinfo_url, host, e);
            return Ok(None);
        }
    };

    let nodeinfo: NodeInfo = match nodeinfo_response.json().await {
        Ok(data) => data,
        Err(e) => {
            tracing::debug!("Failed to parse nodeinfo for {}: {}", host, e);
            return Ok(None);
        }
    };

    tracing::info!(
        "Fetched nodeinfo for {}: {} {}",
        host,
        nodeinfo.software.name,
        nodeinfo.software.version
    );

    Ok(Some(nodeinfo))
}