pub use crate::prelude::*;

/// Query parameters for list
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq, Hash)]
pub struct ItemsListQueryRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<i64>,
}

impl ItemsListQueryRequest {
    pub fn builder() -> ItemsListQueryRequestBuilder {
        <ItemsListQueryRequestBuilder as Default>::default()
    }
}

#[derive(Clone, PartialEq, Default, Debug)]
#[non_exhaustive]
pub struct ItemsListQueryRequestBuilder {
    cursor: Option<String>,
    limit: Option<i64>,
}

impl ItemsListQueryRequestBuilder {
    pub fn cursor(mut self, value: impl Into<String>) -> Self {
        self.cursor = Some(value.into());
        self
    }

    pub fn limit(mut self, value: i64) -> Self {
        self.limit = Some(value);
        self
    }

    /// Consumes the builder and constructs a [`ItemsListQueryRequest`].
    pub fn build(self) -> Result<ItemsListQueryRequest, BuildError> {
        Ok(ItemsListQueryRequest {
            cursor: self.cursor,
            limit: self.limit,
        })
    }
}
