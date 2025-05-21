import axios, { AxiosInstance } from "axios";
import * as dotenv from "dotenv";
import * as fs from "fs";

dotenv.config();

// Jira API configuration
const JIRA_BASE_URL = process.env.JIRA_BASE_URL || "";
const JIRA_EMAIL = process.env.JIRA_EMAIL || "";
const JIRA_API_TOKEN = process.env.JIRA_API_TOKEN || "";
const JIRA_BOARD_ID = process.env.JIRA_BOARD_ID || "";

// Check if required env vars are provided
if (!JIRA_BASE_URL || !JIRA_EMAIL || !JIRA_API_TOKEN || !JIRA_BOARD_ID) {
  console.error(
    "Missing required environment variables. Please check your .env file."
  );
  process.exit(1);
}

// Initialize Jira API client
const jiraClient: AxiosInstance = axios.create({
  baseURL: JIRA_BASE_URL,
  auth: {
    username: JIRA_EMAIL,
    password: JIRA_API_TOKEN,
  },
  headers: {
    "Content-Type": "application/json",
  },
});

interface JiraIssue {
  id: string;
  key: string;
  fields: {
    summary: string;
    status: {
      name: string;
    };
    parent?: {
      key: string;
      fields: {
        summary: string;
      };
    };
  };
}

interface Sprint {
  id: number;
  name: string;
  state: string;
  startDate?: string;
  endDate?: string;
}

// Group issues by epic
interface EpicGroup {
  [epicKey: string]: {
    epicName: string;
    issues: JiraIssue[];
  };
}
// Use a limit on how many sprints to fetch - most recent are most relevant
const MAX_SPRINTS_TO_FETCH = 1000;

async function getAllSprints(boardId: string): Promise<Sprint[]> {
  try {
    const sprints: Sprint[] = [];
    let startAt = 0;
    const maxResults = 50; // Jira's default is often 50
    let isLast = false;

    while (!isLast && sprints.length < MAX_SPRINTS_TO_FETCH) {
      // Get sprints with pagination
      const response = await jiraClient.get(
        `/rest/agile/1.0/board/${boardId}/sprint`,
        {
          params: {
            startAt,
            maxResults,
            // Add state parameter to filter by active and future sprints if desired
            // state: "active,future"
          },
        }
      );

      if (response.data && response.data.values) {
        sprints.push(...response.data.values);

        // Check if this is the last page
        isLast =
          response.data.isLast ||
          startAt + response.data.values.length >= response.data.total;
        startAt = startAt + maxResults;
      } else {
        isLast = true;
      }
    }

    // Sort sprints by start date (most recent first)
    return sprints
      .sort((a, b) => {
        if (!a.startDate || !b.startDate) return 0;
        return (
          new Date(b.startDate).getTime() - new Date(a.startDate).getTime()
        );
      })
      .slice(0, MAX_SPRINTS_TO_FETCH);
  } catch (error) {
    console.error(`Error fetching sprints for board ${boardId}:`, error);
    return [];
  }
}

// Function to find all available boards
async function getAllBoards(): Promise<any[]> {
  try {
    const response = await jiraClient.get("/rest/agile/1.0/board");

    if (response.data && response.data.values) {
      return response.data.values;
    }

    return [];
  } catch (error) {
    console.error("Error fetching boards:", error);
    return [];
  }
}

async function getNextSprint(boardId: string): Promise<Sprint | null> {
  try {
    // First, get all sprints (already sorted by most recent first)
    const allSprints = await getAllSprints(boardId);
    console.log(
      `Found ${allSprints.length} total sprints for board ${boardId}`
    );

    // Log details of sprints to diagnose the issue
    console.log("=== RECENT SPRINTS ===");
    allSprints.forEach((sprint) => {
      console.log(`- ${sprint.name} (ID: ${sprint.id})`);
      console.log(`  State: ${sprint.state}`);
      console.log(`  Start Date: ${sprint.startDate || "Not set"}`);
      console.log(`  End Date: ${sprint.endDate || "Not set"}`);
    });

    // Filter to find future sprints
    const futureSprints = allSprints.filter(
      (sprint) => sprint.state === "future" && !sprint.name.includes("DevOps")
    );
    console.log(`Found ${futureSprints.length} future sprints`);

    // If we have future sprints, use the first one (should be the next upcoming one)
    if (futureSprints.length > 0) {
      // They're already sorted by date in getAllSprints
      return futureSprints[0];
    }

    // If no future sprints, check for active sprints
    console.log("No future sprints found, checking for active sprints...");
    const activeSprints = allSprints.filter(
      (sprint) => sprint.state === "active"
    );

    if (activeSprints.length > 0) {
      console.log(
        `Using active sprint: ${activeSprints[0].name} (${activeSprints[0].state})`
      );
      return activeSprints[0];
    }

    // As a last resort, use the most recent sprint (which could be closed)
    if (allSprints.length > 0) {
      console.log(
        `No active sprints found. Using most recent sprint: ${allSprints[0].name} (${allSprints[0].state})`
      );
      return allSprints[0];
    }

    return null;
  } catch (error) {
    console.error(`Error fetching next sprint for board ${boardId}:`, error);
    return null;
  }
}

async function getReadyToSizeIssuesFromSprint(
  sprintId: number
): Promise<JiraIssue[]> {
  try {
    // JQL to get issues in the sprint with "Ready to Size" status, using custom field cf[10007]
    const jql = `cf[10007] = ${sprintId} AND status = "Ready to Size"`;
    console.log(`Using JQL query: ${jql}`);

    const response = await jiraClient.get("/rest/api/3/search", {
      params: {
        jql,
        fields: "summary,status,parent,cf[10007]",
        maxResults: 100,
      },
    });

    if (response.data && response.data.issues) {
      return response.data.issues as JiraIssue[];
    }

    return [];
  } catch (error) {
    console.error("Error fetching issues:", error);
    return [];
  }
}

// Debug function to check a specific ticket
async function checkSpecificTicket(ticketKey: string): Promise<number | null> {
  try {
    console.log(`\n===== CHECKING TICKET ${ticketKey} =====`);

    // Get ticket details
    const ticket = await jiraClient.get(`/rest/api/3/issue/${ticketKey}`);

    // Check ticket status
    console.log(`Status: ${ticket.data.fields.status.name}`);

    // Find what sprint this ticket is in using custom field cf[10007]
    const customSprint = ticket.data.fields["cf[10007]"];
    let sprintId = null;
    if (
      customSprint &&
      Array.isArray(customSprint) &&
      customSprint.length > 0
    ) {
      const sprint = customSprint[customSprint.length - 1];
      console.log(`Sprint: ${sprint.name} (ID: ${sprint.id})`);
      console.log(`Sprint State: ${sprint.state}`);
      sprintId = sprint.id;

      // Find which board this sprint belongs to
      console.log("Searching for the board containing this sprint...");
      const boards = await getAllBoards();
      console.log(`Found ${boards.length} boards in total`);

      for (const board of boards) {
        console.log(`Checking board: ${board.name} (ID: ${board.id})`);
        const sprints = await getAllSprints(board.id);
        const matchingSprint = sprints.find((s) => s.id === sprint.id);

        if (matchingSprint) {
          console.log(
            `Found matching sprint on board: ${board.name} (ID: ${board.id})`
          );
          // Update the JIRA_BOARD_ID in memory for this run
          console.log(`Using board ID ${board.id} for further processing`);
          return board.id;
        }
      }
    } else {
      console.log("This ticket is not in any sprint");
    }

    // Try searching for this ticket specifically
    const searchQuery = `key = ${ticketKey} AND status = "Ready to Size"`;
    console.log(`\nTrying direct search with: ${searchQuery}`);

    const searchResult = await jiraClient.get("/rest/api/3/search", {
      params: {
        jql: searchQuery,
        fields: "summary,status,cf[10007]",
        maxResults: 1,
      },
    });

    if (searchResult.data.issues && searchResult.data.issues.length > 0) {
      console.log("Found the ticket with direct search!");
    } else {
      console.log("Direct search failed to find the ticket");
    }

    return sprintId ? parseInt(sprintId.toString()) : null;
  } catch (error) {
    console.error("Error checking specific ticket:", error);
    return null;
  }
}

// A more reliable way to get sprint information for specific tickets
async function getSprintFromAgileAPI(
  ticketKey: string
): Promise<Sprint | null> {
  try {
    const agileResponse = await jiraClient.get(
      `/rest/agile/1.0/issue/${ticketKey}`
    );

    // Use custom field cf[10007] for sprint
    const customSprint = agileResponse.data.fields["cf[10007]"];
    if (
      customSprint &&
      Array.isArray(customSprint) &&
      customSprint.length > 0
    ) {
      // Use the most recent sprint (last in the array)
      const sprint = customSprint[customSprint.length - 1];
      console.log(
        `Found sprint for ticket ${ticketKey} using custom field cf[10007]:`
      );
      console.log(`- Sprint Name: ${sprint.name} (ID: ${sprint.id})`);
      console.log(`- Sprint State: ${sprint.state}`);
      console.log(`- Start Date: ${sprint.startDate || "Not set"}`);
      console.log(`- End Date: ${sprint.endDate || "Not set"}`);

      return {
        id: sprint.id,
        name: sprint.name,
        state: sprint.state,
        startDate: sprint.startDate,
        endDate: sprint.endDate,
      };
    }

    console.log(
      `No sprint found for ticket ${ticketKey} in custom field cf[10007]`
    );
    return null;
  } catch (error) {
    console.error(
      `Error getting sprint from Agile API for ticket ${ticketKey}:`,
      error
    );
    return null;
  }
}

function organizeIssuesByEpic(issues: JiraIssue[]): EpicGroup {
  const epicGroups: EpicGroup = {};

  // Group with no epic parent
  epicGroups["NO_EPIC"] = {
    epicName: "Tasks without Epic",
    issues: [],
  };

  issues.forEach((issue) => {
    // Check if issue has a parent epic
    if (issue.fields.parent) {
      const epicKey = issue.fields.parent.key;
      const epicName = issue.fields.parent.fields.summary;

      if (!epicGroups[epicKey]) {
        epicGroups[epicKey] = {
          epicName,
          issues: [],
        };
      }

      epicGroups[epicKey].issues.push(issue);
    } else {
      epicGroups["NO_EPIC"].issues.push(issue);
    }
  });

  // Remove NO_EPIC group if it's empty
  if (epicGroups["NO_EPIC"].issues.length === 0) {
    delete epicGroups["NO_EPIC"];
  }

  return epicGroups;
}

function generateSlackCommands(epicGroups: EpicGroup): string {
  let output = "";

  // Iterate through each epic group
  for (const [epicKey, group] of Object.entries(epicGroups)) {
    // output += "## Epic: " + group.epicName + " (" + epicKey + ")\n\n";

    // Add issues as slack commands
    group.issues.forEach((issue) => {
      const issueUrl = JIRA_BASE_URL + "/browse/" + issue.key;
      output += "/pp " + issueUrl + ` ${issue.fields.summary}` + "\n";
    });

    output += "\n";
  }

  return output;
}

async function main() {
  try {
    // Check if a ticket was specified as a command line argument
    const ticketKey = process.argv[2];

    if (ticketKey) {
      console.log(`Ticket key specified: ${ticketKey}`);
      console.log("Getting sprint information from Agile API...");

      // Get sprint from Agile API for this specific ticket
      const sprint = await getSprintFromAgileAPI(ticketKey);

      if (!sprint) {
        console.error("No sprint found for ticket " + ticketKey + ".");
        return;
      }

      console.log(
        "Using sprint from ticket " +
          ticketKey +
          ": " +
          sprint.name +
          " (ID: " +
          sprint.id +
          ")"
      );
      console.log('Fetching issues with "Ready to Size" status...');

      const issues = await getReadyToSizeIssuesFromSprint(sprint.id);

      if (issues.length === 0) {
        console.log(
          'No issues with "Ready to Size" status found in the sprint.'
        );
        return;
      }

      console.log(
        "Found " + issues.length + ' issues with "Ready to Size" status.'
      );
      console.log("Organizing issues by epic...");

      const epicGroups = organizeIssuesByEpic(issues);
      const slackCommands = generateSlackCommands(epicGroups);

      console.log("\nSlack Commands for Poker Planning:");
      console.log("--------------------------------");
      console.log(slackCommands);

      // Optionally write to a file
      fs.writeFileSync("slack-commands.md", slackCommands);
      console.log("Commands also saved to slack-commands.md");

      return;
    }

    // If no ticket specified, fall back to the board ID approach
    const boardIdToUse = JIRA_BOARD_ID;

    console.log(`\n===== PROCEEDING WITH BOARD ID ${boardIdToUse} =====`);
    console.log("Fetching next sprint...");
    const nextSprint = await getNextSprint(boardIdToUse);

    if (!nextSprint) {
      console.error("No future sprint found.");
      return;
    }

    console.log(`Found next sprint: ${nextSprint.name} (ID: ${nextSprint.id})`);
    console.log('Fetching issues with "Ready to Size" status...');

    const issues = await getReadyToSizeIssuesFromSprint(nextSprint.id);

    if (issues.length === 0) {
      console.log(
        'No issues with "Ready to Size" status found in the next sprint.'
      );
      return;
    }

    console.log(
      "Found " + issues.length + ' issues with "Ready to Size" status.'
    );
    console.log("Organizing issues by epic...");

    const epicGroups = organizeIssuesByEpic(issues);
    const slackCommands = generateSlackCommands(epicGroups);

    console.log("\nSlack Commands for Poker Planning:");
    console.log("--------------------------------");
    console.log(slackCommands);
  } catch (error) {
    console.error("An error occurred:", error);
  }
}

main();
