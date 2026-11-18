#[derive(Default)]
pub struct CloseState {
    ready: bool,
    pending: bool,
    awaiting_decision: bool,
    approved: bool,
}

impl CloseState {
    pub fn request(&mut self) -> bool {
        if self.ready {
            self.awaiting_decision = true;
            true
        } else {
            self.pending = true;
            false
        }
    }

    pub fn ready(&mut self) -> bool {
        self.ready = true;
        if std::mem::take(&mut self.pending) {
            self.awaiting_decision = true;
            true
        } else {
            false
        }
    }

    pub fn delivery_failed(&mut self) {
        self.ready = false;
        self.pending = true;
        self.awaiting_decision = false;
    }

    pub fn approve(&mut self) -> Result<(), String> {
        if !std::mem::take(&mut self.awaiting_decision) {
            return Err("No window close request is awaiting a decision".into());
        }
        self.approved = true;
        Ok(())
    }

    pub fn consume_exit(&mut self, code: Option<i32>) -> bool {
        let approved = std::mem::take(&mut self.approved);
        code == Some(0) && approved
    }

    pub fn cancel(&mut self) {
        self.approved = false;
        self.awaiting_decision = false;
        self.pending = false;
    }
}

#[cfg(test)]
mod tests {
    use super::CloseState;

    #[test]
    fn early_requests_are_replayed_once_after_registration() {
        let mut state = CloseState::default();
        assert!(!state.request());
        assert!(!state.request());
        assert!(state.ready());
        assert!(!state.ready());
        assert!(state.approve().is_ok());
        assert!(state.approve().is_err());
    }

    #[test]
    fn approval_is_scoped_to_one_programmatic_exit_and_cancel_revokes_it() {
        let mut state = CloseState::default();
        state.ready();
        state.request();
        state.approve().unwrap();
        assert!(!state.consume_exit(None));
        assert!(!state.consume_exit(Some(0)));
        state.request();
        state.approve().unwrap();
        assert!(state.consume_exit(Some(0)));
        assert!(!state.consume_exit(Some(0)));
        state.request();
        state.approve().unwrap();
        state.cancel();
        assert!(!state.consume_exit(Some(0)));
    }

    #[test]
    fn failed_delivery_is_retained() {
        let mut state = CloseState::default();
        assert!(!state.ready());
        assert!(state.request());
        state.delivery_failed();
        assert!(state.approve().is_err());
        assert!(!state.request());
        assert!(state.ready());
        assert!(state.approve().is_ok());
    }

    #[test]
    fn approval_requires_an_outstanding_close_and_cancel_revokes_it() {
        let mut state = CloseState::default();
        assert!(state.approve().is_err());
        assert!(!state.ready());
        assert!(state.approve().is_err());
        assert!(state.request());
        state.cancel();
        assert!(state.approve().is_err());
        assert!(state.request());
        assert!(state.approve().is_ok());
    }
}
