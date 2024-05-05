use lazy_static::lazy_static;
use regex_automata::util::captures::Captures;
use regex_automata::meta::Regex;

#[derive(Debug, PartialEq)]
pub enum HttpProxyRoute {
    Streams { },
    Stream { stream_id: usize },
}

lazy_static! {
    static ref ROUTES: Regex = Regex::new_many(&[
        r"^/http/streams$",
        r"^/http/stream/(\d+)$",
    ]).unwrap();
}

pub fn parse_http_proxy_path(path: &str) -> Option<HttpProxyRoute> {
    let mut all = Captures::all(ROUTES.group_info().clone());
    ROUTES.captures(path, &mut all);
    match all.pattern().map(|p| p.as_usize()) {
        Some(0) => {
            Some(HttpProxyRoute::Streams { })
        }
        Some(1) => {
            let stream_id = path[all.get_group(1).unwrap()].parse().unwrap_or_default();
            Some(HttpProxyRoute::Stream { stream_id })
        }
        _ => {
            None
        }
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use anyhow::Result;

    #[tokio::test]
    async fn test_valid_routes() -> Result<()> {
        assert_eq!(parse_http_proxy_path("/http/streams"), Some(HttpProxyRoute::Streams { }));
        assert_eq!(parse_http_proxy_path("/http/stream/2"), Some(HttpProxyRoute::Stream { stream_id: 2 }));
        assert_eq!(parse_http_proxy_path("/http/stream/456"), Some(HttpProxyRoute::Stream { stream_id: 456 }));
        Ok(())
    }

    #[tokio::test]
    async fn test_invalid_routes() -> Result<()> {
        assert_eq!(parse_http_proxy_path("/http/foo"), None);
        assert_eq!(parse_http_proxy_path("/http/foo"), None);
        assert_eq!(parse_http_proxy_path("/http/streams/foo"), None);
        assert_eq!(parse_http_proxy_path("/http/stream/foo"), None);
        assert_eq!(parse_http_proxy_path("/http/stream/2/foo"), None);
        Ok(())
    }
}
