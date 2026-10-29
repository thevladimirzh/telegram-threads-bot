# language: en
Feature: Cleanup of originals and the announce
  After the thread is complete, the forwarded copies are deleted in the threads chat,
  the originals are deleted in the source chat (found via the index of observed
  messages: forward date + sender + content, D21), and the announce
  'Thread created "{title}": https://t.me/{chat_path}/{root_id}?thread={root_id}'
  is posted in the same topic of the source chat (AC4, AC5, D3, D12, D18, D28, D32).
  Per D89 the announce is sent BEFORE the closing message — its message id is needed
  for the closing link `https://t.me/c/{internal_chat_id}/{announce_message_id}` — while
  the thread display order is unchanged (the closing is still the last thread message).
  If the announce cannot be sent, the closing message falls back to the plain chat
  title, no link (S84).
  The closing message and the failure report are thread-body messages: both are
  replies to the title message (D87). The announce keeps its forum-topic behaviour:
  `message_thread_id` is used only there (D18/D69, unchanged).

  Background:
    Given the bot is configured with the global admins "admin"
    And "Source Chat" is connected as a source chat
    And "Threads Chat" is connected as the threads chat
    And user "author" is an admin of "Source Chat"

  @S49 @AC3 @R8 @R62
  Scenario: The forwarded copies are deleted in the threads chat after the thread is posted
    Given the message 10 from user "author" sent at 10:00:00 in "Source Chat" was observed by the bot
    And user "author" forwarded the message 10 of "Source Chat" into "Threads Chat"
    When user "author" picks "Source Chat" and sends the text "Lunch"
    Then a delete call removes the forwarded message from "Threads Chat"
    And the delete call is made after the closing message is posted
    And the closing message is a reply to the title message

  @S50 @AC14 @R1 @R2 @R62 @R63
  Scenario: Originals are deleted only after the whole thread is posted
    Given the message 10 from user "author" sent at 10:00:00 in "Source Chat" was observed by the bot
    And the message 11 from user "author" sent at 10:01:00 in "Source Chat" was observed by the bot
    And user "author" forwarded the messages 10 and 11 of "Source Chat" into "Threads Chat"
    When user "author" picks "Source Chat" and sends the text "Lunch"
    Then the closing message of the thread is posted before the first deletion in "Source Chat"
    And the closing message is a reply to the title message
    And the closing message of the thread is posted after the announce in "Source Chat"
    And the closing message links to the announce message in "Source Chat"

  @S51 @AC4 @R2 @R22
  Scenario: An indexed original is matched by date, sender and content and deleted
    Given the message 10 from user "author" sent at 10:00:00 in "Source Chat" was observed by the bot
    And user "author" forwarded the message 10 of "Source Chat" into "Threads Chat"
    When user "author" picks "Source Chat" and sends the text "Lunch"
    Then a delete call removes exactly the message 10 from "Source Chat"

  @S52 @AC5 @R2 @R22 @R11 @R62
  Scenario: Zero matched originals keep the thread and are reported
    Given the bot has observed no messages of "Source Chat"
    And user "author" forwarded the message 10 of "Source Chat" into "Threads Chat"
    When user "author" picks "Source Chat" and sends the text "Lunch"
    Then the thread is kept with all its messages
    And the report as a reply to the title message says that no originals were found to delete
    And nothing is deleted in "Source Chat"
    And the announce is still posted in "Source Chat"

  @S53 @AC5 @R2 @R17 @R62
  Scenario: An ambiguous match deletes nothing for the ambiguous message
    Given two identical messages 10 and 11 from user "author" sent at 10:00:00 in "Source Chat" were observed by the bot
    And user "author" forwarded a message with that content into "Threads Chat"
    When user "author" picks "Source Chat" and sends the text "Lunch"
    Then nothing is deleted in "Source Chat"
    And the report as a reply to the title message says that the original could not be identified

  @S54 @R18 @R2
  Scenario: Identical content in another source chat is never cross-matched
    Given "Private Source Chat" is also connected as a source chat
    And the message 40 from user "author" sent at 10:00:00 in "Private Source Chat" with the text "Same" was observed by the bot
    And the message 10 from user "author" sent at 10:00:00 in "Source Chat" with the text "Same" was observed by the bot
    And user "author" forwarded the message 10 of "Source Chat" into "Threads Chat"
    When user "author" picks "Source Chat" and sends the text "Lunch"
    Then a delete call removes exactly the message 10 from "Source Chat"
    And no delete call names the message 40 of "Private Source Chat"

  @S55 @R24 @R22
  Scenario: An edited original is matched after its index entry is refreshed
    Given the message 10 from user "author" sent at 10:00:00 in "Source Chat" with the text "Hello" was observed by the bot
    And the message 10 of "Source Chat" was edited to the text "Hello!" and the edit was observed by the bot
    And user "author" forwarded the edited message 10 of "Source Chat" into "Threads Chat"
    When user "author" picks "Source Chat" and sends the text "Lunch"
    Then a delete call removes exactly the message 10 from "Source Chat"

  @S56 @AC5 @R23 @R5 @R62
  Scenario: Originals already deleted before the transfer are reported as failed and the thread is kept
    Given the message 10 from user "author" sent at 10:00:00 in "Source Chat" was observed by the bot
    And deleting the message 10 in "Source Chat" fails with a "message to delete not found" error
    And user "author" forwarded the message 10 of "Source Chat" into "Threads Chat"
    When user "author" picks "Source Chat" and sends the text "Lunch"
    Then the thread is kept with all its messages
    And the report as a reply to the title message names the message 10 as not deleted

  @S57 @AC5 @R5 @R29 @R62
  Scenario: A partial deletion failure keeps the thread and reports how many originals failed
    Given the messages 10, 11 and 12 from user "author" sent at 10:00:00, 10:01:00 and 10:02:00 in "Source Chat" were observed by the bot
    And deleting the message 11 in "Source Chat" fails with a Telegram error
    And user "author" forwarded the messages 10, 11 and 12 of "Source Chat" into "Threads Chat"
    When user "author" picks "Source Chat" and sends the text "Lunch"
    Then the thread is kept with all its messages
    And the report as a reply to the title message says that 1 of 3 originals was not deleted

  @S58 @AC5 @R29 @R62
  Scenario Outline: The failure report counts match the actual deletion outcomes
    Given the messages 10, 11 and 12 from user "author" sent at 10:00:00, 10:01:00 and 10:02:00 in "Source Chat" were observed by the bot
    And deleting <which> of the messages 10, 11 and 12 in "Source Chat" fails with a Telegram error
    And user "author" forwarded the messages 10, 11 and 12 of "Source Chat" into "Threads Chat"
    When user "author" picks "Source Chat" and sends the text "Lunch"
    Then <report>

    Examples:
      | which | report                                                     |
      | none  | no failure report is sent                                  |
      | one   | the report as a reply to the title message says that 1 of 3 originals was not deleted |
      | all   | the report as a reply to the title message says that 3 of 3 originals were not deleted |

  @S59 @AC5 @AC14 @R37 @R11 @R62
  Scenario: The bot demoted before the deletion step keeps the thread and reports a localized failure
    Given the message 10 from user "author" sent at 10:00:00 in "Source Chat" was observed by the bot
    And user "author" forwarded the message 10 of "Source Chat" into "Threads Chat"
    And the bot is removed from the admins of "Source Chat" before the deletion step
    When user "author" picks "Source Chat" and sends the text "Lunch"
    Then the thread is kept with all its messages
    And the report as a reply to the title message is a localized failure message
    And no message contains a raw error dump

  @S60 @AC4 @R4 @R34
  Scenario Outline: The announce is posted with the exact thread link
    Given <threads chat> is connected as the threads chat
    And the message 10 from user "author" sent at 10:00:00 in "Source Chat" was observed by the bot
    And user "author" forwarded the message 10 of "Source Chat" into <threads chat>
    And the next message created by the bot gets the id 42
    When user "author" picks "Source Chat" and sends the text "Lunch"
    Then the announce in "Source Chat" is exactly 'Thread created "Lunch": <url>'

    Examples:
      | threads chat           | url                                             |
      | "Threads Chat"         | https://t.me/threads_chat/42?thread=42          |
      | "Private Threads Chat" | https://t.me/c/200000000000005/42?thread=42     |

  @S61 @AC4 @R13 @R35
  Scenario: The announce goes to the same forum topic as the forwarded messages
    Given "Forum Chat" is a forum with the topic 7
    And "Forum Chat" is connected as a source chat
    And the message 10 from user "author" sent at 10:00:00 in the topic 7 of "Forum Chat" was observed by the bot
    And user "author" forwarded the message 10 of "Forum Chat" into "Threads Chat"
    When user "author" picks "Forum Chat" and sends the text "Lunch"
    Then the announce is posted in "Forum Chat" with message_thread_id 7

  @S62 @R13 @R36
  Scenario: A batch spanning several forum topics announces in the topic of the first message
    Given "Forum Chat" is a forum with the topics 7 and 9
    And "Forum Chat" is connected as a source chat
    And the message 10 from user "author" sent at 10:00:00 in the topic 7 of "Forum Chat" was observed by the bot
    And the message 11 from user "author" sent at 10:01:00 in the topic 9 of "Forum Chat" was observed by the bot
    And user "author" forwarded the messages 10 and 11 of "Forum Chat" into "Threads Chat"
    When user "author" picks "Forum Chat" and sends the text "Lunch"
    Then the announce is posted in "Forum Chat" with message_thread_id 7
    And no announce is posted with message_thread_id 9

  @S63 @AC4 @AC5 @R4 @R5 @R62
  Scenario: The announce is posted even when no originals could be deleted
    Given the message 10 from user "author" sent at 10:00:00 in "Source Chat" was observed by the bot
    And deleting every original in "Source Chat" fails with a Telegram error
    And user "author" forwarded the message 10 of "Source Chat" into "Threads Chat"
    When user "author" picks "Source Chat" and sends the text "Lunch"
    Then the announce in "Source Chat" is exactly 'Thread created "Lunch": https://t.me/threads_chat/42?thread=42'
    And the report as a reply to the title message lists the originals that were not deleted

  @S84 @AC3 @R63
  Scenario: When the announce cannot be sent the closing message names the plain chat title without a link
    Given the message 10 from user "author" sent at 10:00:00 in "Source Chat" was observed by the bot
    And user "author" forwarded the message 10 of "Source Chat" into "Threads Chat"
    And sending the announce in "Source Chat" fails with a Telegram error
    When user "author" picks "Source Chat" and sends the text "Lunch"
    Then the closing message of the thread is exactly 'Lunch — moved from Source Chat'
    And the closing message is a reply to the title message
    And the thread is kept with all its messages
