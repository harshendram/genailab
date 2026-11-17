const chalk = require("chalk");
const { analyzeEmails: analyzeEmailsAI } = require("../ai/geminiAI");

/**
 * Analyze a single email
 * @param {Object} email Email object
 * @returns {Promise<Object>} Analyzed email with classification, summary, and suggested response
 */
async function analyzeEmail(email) {
  try {
    // For single email, use the batch function with array of one email
    const results = await analyzeEmailsAI([email]);
    return results[0];
  } catch (error) {
    console.error(`Error analyzing email "${email.subject}":`, error.message);
    // Return email with basic analysis if AI fails
    return {
      ...email,
      classification: {
        priority: "medium",
        priorityConfidence: 0,
        type: "general",
        actionRequired: false,
        actionConfidence: 0,
        actionItems: [],
      },
      summary: {
        summary: ["Unable to generate summary"],
        keyPoints: [],
        deadlines: [],
        estimatedReadingTime: 1,
      },
      suggestedResponse: "Unable to generate response.",
    };
  }
}

/**
 * Analyze multiple emails
 * @param {Array} emails Array of email objects
 * @returns {Promise<Array>} Array of analyzed emails
 */
async function analyzeEmails(emails) {
  // One call for all emails: the AI module groups them into batches itself
  // (config batchSize per request), instead of 3 requests per email.
  const analyzedEmails = await analyzeEmailsAI(emails, (step, batchNum, totalBatches) => {
    console.log(chalk.gray(`  ${step}: batch ${batchNum}/${totalBatches}`));
  });

  // Sort emails by priority
  const priorityOrder = { Urgent: 0, Important: 1, Normal: 2 };
  const rank = (email) => priorityOrder[email.classification && email.classification.priority] ?? 2;
  return analyzedEmails.sort((a, b) => rank(a) - rank(b));
}

/**
 * Generate daily summary report
 * @param {Array} analyzedEmails Array of analyzed emails
 * @returns {Object} Daily summary report
 */
function generateDailySummary(analyzedEmails) {
  // Count emails by priority
  const priorityCounts = {
    Urgent: 0,
    Important: 0,
    Normal: 0,
  };

  // Find actionable emails
  const actionableEmails = [];

  // Find time-sensitive emails
  const timeSensitiveEmails = [];

  analyzedEmails.forEach((email) => {
    const classification = email.classification || {};
    const priority = classification.priority in priorityCounts ? classification.priority : "Normal";
    priorityCounts[priority]++;

    if (classification.actionRequired) {
      actionableEmails.push({
        subject: email.subject,
        from: email.from,
        priority,
        actionItems: classification.actionItems || [],
      });
    }

    const deadlines = (email.summary && email.summary.deadlines) || [];
    if (deadlines.length > 0) {
      timeSensitiveEmails.push({
        subject: email.subject,
        from: email.from,
        priority,
        deadlines,
      });
    }
  });

  return {
    date: new Date(),
    totalEmails: analyzedEmails.length,
    priorityCounts,
    actionableEmails,
    timeSensitiveEmails,
  };
}

module.exports = {
  analyzeEmail,
  analyzeEmails,
  generateDailySummary,
};
