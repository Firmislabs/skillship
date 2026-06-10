pub use crate::prelude::*;

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq, Hash)]
pub struct EventsListResponseDataResultsItem {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
}

impl EventsListResponseDataResultsItem {
    pub fn builder() -> EventsListResponseDataResultsItemBuilder {
        <EventsListResponseDataResultsItemBuilder as Default>::default()
    }
}

#[derive(Clone, PartialEq, Default, Debug)]
#[non_exhaustive]
pub struct EventsListResponseDataResultsItemBuilder {
    id: Option<String>,
}

impl EventsListResponseDataResultsItemBuilder {
    pub fn id(mut self, value: impl Into<String>) -> Self {
        self.id = Some(value.into());
        self
    }

    /// Consumes the builder and constructs a [`EventsListResponseDataResultsItem`].
    pub fn build(self) -> Result<EventsListResponseDataResultsItem, BuildError> {
        Ok(EventsListResponseDataResultsItem { id: self.id })
    }
}
