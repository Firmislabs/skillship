pub use crate::prelude::*;

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq, Hash)]
pub struct ItemsListResponseDataItem {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

impl ItemsListResponseDataItem {
    pub fn builder() -> ItemsListResponseDataItemBuilder {
        <ItemsListResponseDataItemBuilder as Default>::default()
    }
}

#[derive(Clone, PartialEq, Default, Debug)]
#[non_exhaustive]
pub struct ItemsListResponseDataItemBuilder {
    id: Option<String>,
    name: Option<String>,
}

impl ItemsListResponseDataItemBuilder {
    pub fn id(mut self, value: impl Into<String>) -> Self {
        self.id = Some(value.into());
        self
    }

    pub fn name(mut self, value: impl Into<String>) -> Self {
        self.name = Some(value.into());
        self
    }

    /// Consumes the builder and constructs a [`ItemsListResponseDataItem`].
    pub fn build(self) -> Result<ItemsListResponseDataItem, BuildError> {
        Ok(ItemsListResponseDataItem {
            id: self.id,
            name: self.name,
        })
    }
}
