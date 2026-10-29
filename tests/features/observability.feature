# language: en
Feature: Observability endpoints and logs
  The process exposes liveness and readiness over HTTP and writes structured logs
  to stdout (AC9, D20). The mode switch (polling default, webhook opt-in) is covered
  in configuration.feature.

  @S80 @AC9
  Scenario: /health answers 200 while the bot runs
    Given the bot is running
    When the HTTP endpoint /health is requested
    Then the response status is 200

  @S81 @AC9
  Scenario Outline: /ready reflects the database ping
    Given the bot is running
    And the database ping <db state>
    When the HTTP endpoint /ready is requested
    Then the response status is <status>

    Examples:
      | db state | status |
      | succeeds | 200    |
      | fails    | 503    |

  @S82 @AC9
  Scenario: Operational logs are single-line JSON records on stdout
    Given the bot is running with the default logger attached
    When a transfer completes
    Then every log line on stdout parses as a JSON record
