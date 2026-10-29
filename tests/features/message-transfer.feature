# language: en
Feature: Copying the forwarded messages into the thread
  The forwarded messages become bot messages in the thread with no author
  attribution: every copy is a reply to the title message (D87); albums are copied
  per item — contiguous and in source order, media-group grouping is intentionally
  lost (D88); non-transferable content is replaced by exact placeholders (AC3, D5, D27).

  Background:
    Given the bot is configured with the global admins "admin"
    And "Source Chat" is connected as a source chat
    And "Threads Chat" is connected as the threads chat
    And user "author" is an admin of "Source Chat"

  @S42 @AC3 @R15 @R8 @R62
  Scenario: Copies are sent as bot messages without author attribution
    Given the message 10 from user "author" sent at 10:00:00 in "Source Chat" was observed by the bot
    And user "author" forwarded the message 10 of "Source Chat" into "Threads Chat"
    When user "author" picks "Source Chat" and sends the text "Lunch"
    Then every copy is posted as a new message of the bot and never as a forward
    And each copy is a reply to the title message
    And no copy contains the name of user "author" or a forward header

  @S43 @AC3 @R8 @R21 @R62
  Scenario: The order of the forwarded messages is preserved in the thread
    Given the messages 10, 11 and 12 from user "author" sent at 10:00:00, 10:01:00 and 10:02:00 in "Source Chat" were observed by the bot
    And user "author" forwarded the messages 10, 11 and 12 of "Source Chat" into "Threads Chat"
    When user "author" picks "Source Chat" and sends the text "Lunch"
    Then the copies appear in the thread in the source order 10, 11, 12
    And each copy is a reply to the title message

  @S44 @AC3 @R20 @R21 @R8 @R62
  Scenario: An album is copied as a contiguous group in source order
    Given the album with the media_group_id "grp1" contains the messages 20 and 21 of "Source Chat"
    And the messages 20 and 21 were observed by the bot in the source order 20, 21
    And user "author" forwarded the messages 20 and 21 of "Source Chat" into "Threads Chat"
    When user "author" picks "Source Chat" and sends the text "Lunch"
    Then the album is copied per item
    And the copies of the messages 20 and 21 are adjacent in the thread
    And the copies appear in the thread in the source order 20, 21
    And each copy is a reply to the title message

  @S45 @R20 @R21 @R62
  Scenario: Album updates arriving split and out of order are grouped by their album id
    Given the album with the media_group_id "grp1" contains the messages 20 and 21 of "Source Chat"
    And the bot observed the message 21 first and the message 20 second
    When user "author" forwards the messages 20 and 21 of "Source Chat" into "Threads Chat" and completes the dialog
    Then the album is copied per item
    And the copies of the messages 20 and 21 are adjacent in the thread
    And the copies appear in the thread in the source order 20, 21
    And each copy is a reply to the title message

  @S46 @AC3 @R41
  Scenario Outline: Non-transferable content is replaced by an exact placeholder
    Given the batch of user "author" contains a <kind> message with the value <value>
    And user "author" forwarded the batch into "Threads Chat"
    When user "author" picks "Source Chat" and sends the text "Lunch"
    Then the thread contains the placeholder '<placeholder>' instead of a copy

    Examples:
      | kind    | value                     | placeholder                             |
      | poll    | "Lunch?"                  | [poll] Lunch?                           |
      | service | message_chat_join_by_link | [service] message_chat_join_by_link     |
      | invoice | invoice                   | [unsupported] invoice                   |

  @S47 @R43
  Scenario: A reply inside the batch is copied as a plain message
    Given the message 10 from user "author" sent at 10:00:00 in "Source Chat" was observed by the bot
    And the message 11 from user "author" sent at 10:01:00 in "Source Chat" is a reply to the message 10
    And user "author" forwarded the messages 10 and 11 of "Source Chat" into "Threads Chat"
    When user "author" picks "Source Chat" and sends the text "Lunch"
    Then the copy of the message 11 has no reply reference into "Source Chat"
    And the transfer does not fail

  @S48 @AC3 @R8
  Scenario: A text message is copied with its text verbatim
    Given the message 10 from user "author" sent at 10:00:00 in "Source Chat" with the text "Hello, world!" was observed by the bot
    And user "author" forwarded the message 10 of "Source Chat" into "Threads Chat"
    When user "author" picks "Source Chat" and sends the text "Lunch"
    Then the thread contains a copy with the text "Hello, world!"
