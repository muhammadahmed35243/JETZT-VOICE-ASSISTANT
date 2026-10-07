-- A caller whose email can't be confirmed by voice (a test call failed the
-- read-back three times) can still leave a message: the team calls back on
-- caller_phone instead. Before this, take_message had nowhere to put it and
-- the message was lost.
alter table fallback_messages alter column contact_email drop not null;
