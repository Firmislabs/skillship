pub use crate::prelude::*;

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq, Hash)]
pub struct EventsListResponse {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<EventsListResponseData>,
}

impl EventsListResponse {
    pub fn builder() -> EventsListResponseBuilder {
        <EventsListResponseBuilder as Default>::default()
    }
}

#[derive(Clone, PartialEq, Default, Debug)]
#[non_exhaustive]
pub struct EventsListResponseBuilder {
    data: Option<EventsListResponseData>,
}

impl EventsListResponseBuilder {
    pub fn data(mut self, value: EventsListResponseData) -> Self {
        self.data = Some(value);
        self
    }

    /// Consumes the builder and constructs a [`EventsListResponse`].
    pub fn build(self) -> Result<EventsListResponse, BuildError> {
        Ok(EventsListResponse { data: self.data })
    }
}
