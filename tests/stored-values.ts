// Values that state files written by older versions of sous chef still hold.
//
// The sc under test must still read them, so the literal value is the contract: they are
// written out here rather than imported from the code under test.

/** `waiting_on` in events written before the owner was a setting (now "owner"). */
export const LEGACY_OWNER = "dylan";
/** The key in a Slack event's "slack" block written before the owner was a setting (now "from_owner"). */
export const LEGACY_FROM_OWNER = "from_dylan";
