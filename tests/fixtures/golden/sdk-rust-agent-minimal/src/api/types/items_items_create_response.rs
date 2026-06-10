pub use crate::prelude::*;

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq, Hash)]
pub struct ItemsCreateResponse {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

impl ItemsCreateResponse {
    pub fn builder() -> ItemsCreateResponseBuilder {
        <ItemsCreateResponseBuilder as Default>::default()
    }
}

#[derive(Clone, PartialEq, Default, Debug)]
#[non_exhaustive]
pub struct ItemsCreateResponseBuilder {
    id: Option<String>,
    name: Option<String>,
}

impl ItemsCreateResponseBuilder {
    pub fn id(mut self, value: impl Into<String>) -> Self {
        self.id = Some(value.into());
        self
    }

    pub fn name(mut self, value: impl Into<String>) -> Self {
        self.name = Some(value.into());
        self
    }

    /// Consumes the builder and constructs a [`ItemsCreateResponse`].
    pub fn build(self) -> Result<ItemsCreateResponse, BuildError> {
        Ok(ItemsCreateResponse {
            id: self.id,
            name: self.name,
        })
    }
}
