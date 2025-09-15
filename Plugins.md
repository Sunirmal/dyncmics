1) C# Plugin Code
Create a new Class Library project (target .NET Framework 4.6.2) and add a reference to the Dataverse assemblies (Microsoft.CrmSdk.CoreAssemblies / Microsoft.Xrm.Sdk). Name the file ContractProcessingPlugin.cs.


using System;
using System.ServiceModel;
using Microsoft.Xrm.Sdk;
using Microsoft.Xrm.Sdk.Query;

namespace Contoso.Plugins
{
    /// <summary>
    /// Validates and processes Contract records on Create/Update.
    /// Register on: Message = Create, Update; PrimaryEntity = contract; Stage = PreOperation (20); Mode = Synchronous
    /// </summary>
    public class ContractProcessingPlugin : IPlugin
    {
        // If you want to use unsecure configuration, you can pass it into the constructor (PluginRegistration Tool allows this)
        private readonly string _unsecureConfig;

        public ContractProcessingPlugin() { }

        // Optional constructor that receives unsecureConfig (registered via Plugin Registration Tool)
        public ContractProcessingPlugin(string unsecureConfig)
        {
            _unsecureConfig = unsecureConfig;
        }

        public void Execute(IServiceProvider serviceProvider)
        {
            // Obtain the tracing service
            var tracingService = (ITracingService)serviceProvider.GetService(typeof(ITracingService));

            // Obtain the execution context from the service provider.
            var context = (IPluginExecutionContext)serviceProvider.GetService(typeof(IPluginExecutionContext));

            // Obtain the organization service reference which you will need for web service calls.
            var factory = (IOrganizationServiceFactory)serviceProvider.GetService(typeof(IOrganizationServiceFactory));
            var service = factory.CreateOrganizationService(context.UserId);

            try
            {
                tracingService.Trace("ContractProcessingPlugin: Entering Execute");

                // We expect the Target to be an Entity for Create/Update
                if (!context.InputParameters.Contains("Target") || !(context.InputParameters["Target"] is Entity))
                {
                    tracingService.Trace("ContractProcessingPlugin: No target entity - nothing to do.");
                    return;
                }

                var entity = (Entity)context.InputParameters["Target"];

                // Only proceed if this is the contract entity. Some registration may use different logical name.
                if (entity.LogicalName != "contract")
                {
                    tracingService.Trace($"ContractProcessingPlugin: Skipping entity {entity.LogicalName}");
                    return;
                }

                tracingService.Trace("ContractProcessingPlugin: Processing contract record.");

                // Get values — note: in PreOperation some attributes may or may not be present depending on the message and which attributes changed
                DateTime? startDate = GetAttributeValueAsDateTime(entity, "startdate");     // replace with your date field if different
                DateTime? endDate = GetAttributeValueAsDateTime(entity, "enddate");         // replace if different

                // If either date is missing on Create, try to load full record (if update scenario we may need to get existing values)
                if (context.MessageName == "Update")
                {
                    // If one of the dates is null, retrieve the full record to compare existing values
                    if (!startDate.HasValue || !endDate.HasValue)
                    {
                        // Retrieve the full record from DB to get existing values when attribute not provided in Target
                        var cols = new ColumnSet("startdate", "enddate", "title");
                        var existing = service.Retrieve("contract", entity.Id, cols);
                        if (!startDate.HasValue)
                            startDate = GetAttributeValueAsDateTime(existing, "startdate");
                        if (!endDate.HasValue)
                            endDate = GetAttributeValueAsDateTime(existing, "enddate");
                    }
                }

                // Validate: endDate must be >= startDate if both present
                if (startDate.HasValue && endDate.HasValue)
                {
                    tracingService.Trace($"ContractProcessingPlugin: startDate={startDate}, endDate={endDate}");
                    if (endDate.Value < startDate.Value)
                    {
                        tracingService.Trace("ContractProcessingPlugin: Validation failed - endDate < startDate");
                        // Throw InvalidPluginExecutionException — this will display to the user
                        throw new InvalidPluginExecutionException("Contract End Date cannot be earlier than Start Date. Please correct the dates.");
                    }
                }

                // Example: If title is missing in Target (or blank), set a default title before record is created/updated.
                // Because this is PreOperation, we can add to context Target so the value will be saved with the operation.
                if (!entity.Contains("title") || string.IsNullOrWhiteSpace(entity.GetAttributeValue<string>("title")))
                {
                    // Build default title (could include account related info, etc.)
                    string defaultTitle = $"Contract - {DateTime.UtcNow:yyyy-MM-dd}";
                    entity["title"] = defaultTitle;
                    tracingService.Trace($"ContractProcessingPlugin: Title was missing - setting default title: {defaultTitle}");
                }

                // Example: Use unsecure config optionally to toggle behavior
                if (!string.IsNullOrWhiteSpace(_unsecureConfig))
                {
                    tracingService.Trace($"ContractProcessingPlugin: Unsecure config: {_unsecureConfig}");
                    // you may parse and use config (e.g., min-term-days=30) to apply additional validations
                }

                tracingService.Trace("ContractProcessingPlugin: Completed successfully.");
            }
            catch (InvalidPluginExecutionException)
            {
                // rethrow so platform handles and shows message to user
                throw;
            }
            catch (Exception ex)
            {
                // Trace and wrap in InvalidPluginExecutionException for a friendly message.
                tracingService.Trace($"ContractProcessingPlugin: Exception: {ex.ToString()}");
                throw new InvalidPluginExecutionException("An error occurred in ContractProcessingPlugin. Check the trace log for details.", ex);
            }
        }

        private DateTime? GetAttributeValueAsDateTime(Entity e, string attributeLogicalName)
        {
            if (e == null) return null;
            if (e.Contains(attributeLogicalName) && e[attributeLogicalName] is DateTime)
            {
                return (DateTime)e[attributeLogicalName];
            }
            return null;
        }
    }
}

2) Build & Packaging
	1. Create a Class Library project targeting .NET Framework 4.6.2 (recommended for classic plugin model).
	2. Add NuGet package Microsoft.CrmSdk.CoreAssemblies (or reference CRM SDK assemblies appropriate to your environment).
	3. Build the project in Release mode.
	4. You will get an assembly (DLL) to register.

3) Register the Plugin (Plugin Registration Tool / Power Platform Tools)
Use the Plugin Registration Tool (part of the XrmToolBox / or SDK tools) or the Power Platform CLI (or Developer Toolkit). Steps (Plugin Registration Tool):
	1. Connect to your environment.
	2. Click Register → Register New Assembly.
		○ Select the compiled DLL.
		○ Choose Allow Dynamic Assembly Loading (default).
		○ Optionally provide Assembly Name and Description.
		○ Provide Unsecure Configuration value if you want to pass simple parameters (e.g., minTermDays=30).
	3. After assembly is registered, expand it and Register New Step:
		○ Message: Create
			§ Primary Entity: contract
			§ Event Pipeline Stage of Execution: PreOperation (20) (pre-image changes are not committed yet)
			§ Execution Mode: Synchronous
			§ Filtering Attributes: leave empty or add startdate,enddate,title for optimization
			§ Deployment: Server (sandbox)
		○ Message: Update
			§ Same settings as above; specify Filtering Attributes to startdate,enddate,title to limit invocations only when required fields change.
	4. Optionally register a Pre-image if you need the previous state in the plugin. For this plugin we retrieved the record via service when needed, but you may want to register a pre-image with attributes startdate,enddate,title.
	5. Save.

4) Common Registration Configurations & Notes
	• Stage: Use PreOperation for validation and to modify the Target before persistence. If you need to react after the record has been saved, use PostOperation.
	• Execution Mode: Synchronous for immediate user feedback (validation errors will show to user). Asynchronous for long-running background processing.
	• Sandbox: Most cloud tenants require Sandbox isolation. Your plugin must be compatible (no unsupported native calls).
	• Filtering Attributes: Add only attributes that should trigger the plugin on Update (reduces unnecessary plugin runs).
	• Secure/Unsecure configuration: Pass config string when registering the assembly and read it via plugin constructor for behavior toggles.
	• Error handling: Throw InvalidPluginExecutionException for user-friendly validation messages. Log details via ITracingService for troubleshooting.
	• Unit testing: Use fakes/mocks for IOrganizationService, IPluginExecutionContext in unit tests. Libraries like FakeXrmEasy simplify testing.

5) Example: Pre-image alternative (recommended for performance)
If you register a pre-image, the platform will include the pre-change values in context.PreEntityImages["PreImageName"]. This avoids an extra retrieve call. Example registration: when registering the step, add pre-image name PreImage and specify attributes startdate,enddate,title. Then in code:
Entity preImage = null;
if (context.PreEntityImages.Contains("PreImage") && context.PreEntityImages["PreImage"] is Entity)
{
    preImage = (Entity)context.PreEntityImages["PreImage"];
    // read values from preImage
}

6) Example: Throwing a localized user error
Use InvalidPluginExecutionException("Friendly message") — the user will see it in the UI. Avoid exposing stack traces to users; log them in tracing.

7) Quick Troubleshooting & Testing
	• Enable Plugin Trace Log (in Power Platform Admin Center) to capture ITracingService traces when exceptions occur.
	• Test by creating/updating a Contract record with End Date earlier than Start Date; you should see the validation message.
	• If plugin doesn't fire:
		○ Confirm correct entity logical name.
		○ Check message (Create/Update) and filtering attributes.
		○ Confirm assembly is enabled and not step disabled.
		○ Ensure you registered step in correct environment.

8) Extending plugin (ideas)
	• Enforce business rules (minimum term length), set automatic status/price calculations.
	• Call external systems asynchronously (via Azure Function) — use an async step.
	• Implement plugin that creates child records (e.g., generate Tasks for contract onboarding).
	• Add telemetry (App Insights) for monitoring (careful with sandbox limitations).

If you want, I can:
	• Provide a variant plugin that runs on Contact and sets fullname, or one that auto-creates related records (e.g., create initial invoice when contract created).
	• Provide a sample unit test using FakeXrmEasy.
	• Give step-by-step screenshots / exact Plugin Registration Tool steps (I can generate a short checklist or PDF).
	• Produce a ready-to-import solution with assembly and steps documented.
Which follow-up would you like?

From <https://chatgpt.com/c/68c1dad3-96e8-8320-9fe1-1f957113d70d> 


From <https://chatgpt.com/c/68c1dad3-96e8-8320-9fe1-1f957113d70d> 



Got it 👍 — you want a Dynamics 365 / Dataverse plugin that fires when a new record is created and simply reads the input record values (the “message” here is the Create message in CRM).
Here’s a minimal plugin example in C# that demonstrates how to read the target entity (the new record) when it’s being created:

C# Plugin – Read record on Create
using System;
using Microsoft.Xrm.Sdk;
namespace Contoso.Plugins
{
    public class ReadOnCreatePlugin : IPlugin
    {
        public void Execute(IServiceProvider serviceProvider)
        {
            // Tracing service for logging
            var tracingService = (ITracingService)serviceProvider.GetService(typeof(ITracingService));
// Context
            var context = (IPluginExecutionContext)serviceProvider.GetService(typeof(IPluginExecutionContext));
// Check if this is a Create message
            if (context.MessageName != "Create") return;
// Get the Target entity (the record being created)
            if (context.InputParameters.Contains("Target") && context.InputParameters["Target"] is Entity entity)
            {
                tracingService.Trace($"Plugin fired on Create of {entity.LogicalName}");
// Example: Read attribute values
                foreach (var attr in entity.Attributes)
                {
                    tracingService.Trace($"Attribute: {attr.Key}, Value: {attr.Value}");
                }
// Example: Read specific field, e.g. "name"
                if (entity.Contains("name"))
                {
                    var name = entity.GetAttributeValue<string>("name");
                    tracingService.Trace($"New record name: {name}");
                }
            }
        }
    }
}

Registration Steps
	1. Build and register the assembly in Plugin Registration Tool.
	2. Register a Step:
		○ Message: Create
		○ Primary Entity: your target table (e.g., contact, account, contract)
		○ Stage: PreOperation (if you want to read/modify before save) or PostOperation (to act after save)
		○ Execution Mode: Synchronous (if you want immediate behavior)
	3. Save and test.

How it behaves
	• When a new record is created, the plugin will fire.
	• It will read all attributes of the record (those provided at creation).
	• Traces will be written to the Plugin Trace Log (enable it in Power Platform Admin Center).

👉 Do you want me to extend this so it sends a message/notification (email, Teams, etc.) when a new record is created, or just keep it as a simple “read and log attributes” example?

From <https://chatgpt.com/c/68c1dad3-96e8-8320-9fe1-1f957113d70d> 


From <https://chatgpt.com/c/68c1dad3-96e8-8320-9fe1-1f957113d70d> 




Good call 👍 — every Event record should have a unique Event ID that you can use as a reference key (different from the system-generated GUID).
Here’s how we update the schema:

Updated Event Entity (new_event)
Core Fields
Display Name	Schema Name	Data Type	Example Value
Event ID	new_eventid	Single Line of Text	EVT-2025-001
Event Name	new_eventname	Single Line of Text	Sales Summit 2025
Event Date	new_eventdate	Date & Time	2025-09-20 09:30 AM
Location	new_location	Single Line of Text	Bangalore ITC Gardenia
Organizer	new_organizer	Lookup (Contact/User)	Jane Smith
Description	new_description	Multiple Lines of Text	Annual event for sales team
Event Type	new_eventtype	Choice (Option Set)	Conference, Webinar, Training
Attendee Count	new_attendeecount	Whole Number	300
Status	new_status	Choice (Option Set)	Planned, In Progress, Completed, Cancelled

Auto-Generate Event ID with Plugin
You usually don’t want the user to enter IDs manually.
We can write a Pre-Create Plugin to auto-generate Event ID like EVT-2025-001.
Plugin Snippet for Auto Event ID
using System;
using Microsoft.Xrm.Sdk;
using Microsoft.Xrm.Sdk.Query;
namespace D365PluginDemo
{
    public class EventPreCreatePlugin : IPlugin
    {
        public void Execute(IServiceProvider serviceProvider)
        {
            IPluginExecutionContext context = (IPluginExecutionContext)serviceProvider.GetService(typeof(IPluginExecutionContext));
            IOrganizationServiceFactory serviceFactory = (IOrganizationServiceFactory)serviceProvider.GetService(typeof(IOrganizationServiceFactory));
            IOrganizationService service = serviceFactory.CreateOrganizationService(context.UserId);
            ITracingService tracingService = (ITracingService)serviceProvider.GetService(typeof(ITracingService));
try
            {
                if (context.InputParameters.Contains("Target") && context.InputParameters["Target"] is Entity)
                {
                    Entity eventEntity = (Entity)context.InputParameters["Target"];
if (eventEntity.LogicalName == "new_event")
                    {
                        // Query existing event count
                        QueryExpression query = new QueryExpression("new_event")
                        {
                            ColumnSet = new ColumnSet("new_eventid")
                        };
                        EntityCollection results = service.RetrieveMultiple(query);
int count = results.Entities.Count + 1;
                        string year = DateTime.Now.Year.ToString();
                        string eventId = $"EVT-{year}-{count:D3}";
eventEntity["new_eventid"] = eventId;
tracingService.Trace("Assigned Event ID: " + eventId);
                    }
                }
            }
            catch (Exception ex)
            {
                tracingService.Trace("EventPreCreatePlugin: {0}", ex.ToString());
                throw new InvalidPluginExecutionException("An error occurred in EventPreCreatePlugin.", ex);
            }
        }
    }
}

🔑 Key Notes:
	• Run this plugin in Pre-Create stage so the Event ID is set before the record is saved.
	• The Event ID format is EVT-<Year>-<RunningNumber> (e.g., EVT-2025-001).
	• If needed, you can replace this simple counter logic with a more robust custom numbering table.

👉 Do you want me to also add auto-status setting (default to Planned on creation) inside this same plugin, or keep it separate?

From <https://chatgpt.com/c/68c469aa-149c-8327-b23a-d35d969a79ef> 


From <https://chatgpt.com/c/68c469aa-149c-8327-b23a-d35d969a79ef> 


Change based on the status

Got it ✅ — you want the plugin to run only when the Event record’s current status = “New”, and if not, it should simply exit without processing.
I’ll update the plugin code to check the new_status field before doing any processing.

🔧 Updated Plugin Code (with Status Check)
using System;
using Microsoft.Xrm.Sdk;
using Microsoft.Xrm.Sdk.Query;
namespace D365PluginDemo
{
    public class EventPreCreatePlugin : IPlugin
    {
        public void Execute(IServiceProvider serviceProvider)
        {
            IPluginExecutionContext context = 
                (IPluginExecutionContext)serviceProvider.GetService(typeof(IPluginExecutionContext));
            IOrganizationServiceFactory serviceFactory = 
                (IOrganizationServiceFactory)serviceProvider.GetService(typeof(IOrganizationServiceFactory));
            IOrganizationService service = serviceFactory.CreateOrganizationService(context.UserId);
            ITracingService tracingService = 
                (ITracingService)serviceProvider.GetService(typeof(ITracingService));
try
            {
                if (context.InputParameters.Contains("Target") && 
                    context.InputParameters["Target"] is Entity)
                {
                    Entity eventEntity = (Entity)context.InputParameters["Target"];
if (eventEntity.LogicalName == "new_event")
                    {
                        // Check if status exists and is "New"
                        if (eventEntity.Contains("new_status") && 
                            eventEntity["new_status"] is OptionSetValue statusValue)
                        {
                            // Assuming "New" = 100000000 in the Option Set
                            if (statusValue.Value != 100000000)
                            {
                                tracingService.Trace("EventPreCreatePlugin: Skipping because status is not New.");
                                return; // Exit without processing
                            }
                        }
                        else
                        {
                            tracingService.Trace("EventPreCreatePlugin: No status set, skipping.");
                            return;
                        }
// ✅ Now process only if status = New
                        QueryExpression query = new QueryExpression("new_event")
                        {
                            ColumnSet = new ColumnSet("new_eventid")
                        };
                        EntityCollection results = service.RetrieveMultiple(query);
int count = results.Entities.Count + 1;
                        string year = DateTime.Now.Year.ToString();
                        string eventId = $"EVT-{year}-{count:D3}";
eventEntity["new_eventid"] = eventId;
tracingService.Trace("Assigned Event ID: " + eventId);
                    }
                }
            }
            catch (Exception ex)
            {
                tracingService.Trace("EventPreCreatePlugin: {0}", ex.ToString());
                throw new InvalidPluginExecutionException("An error occurred in EventPreCreatePlugin.", ex);
            }
        }
    }
}

⚡ Key Points
	• new_status is assumed to be an OptionSet (Choice field).
		○ You must confirm the numeric value for “New” in your system (usually something like 100000000).
		○ You can check this in Solution → Event entity → Field → Status (Option Set) → Option values.
	• If the status is not “New”, the plugin exits without doing anything.
	• If status = New, the plugin assigns the Event ID.

👉 Do you also want me to make the plugin set the status automatically to “Planned” after generating the Event ID (so the record moves forward in workflow)?

From <https://chatgpt.com/c/68c469aa-149c-8327-b23a-d35d969a79ef> 


From <https://chatgpt.com/c/68c469aa-149c-8327-b23a-d35d969a79ef> 


Got it 👍 — let’s break this down carefully.
You want your plugin (triggered on Opportunity) to:
	1. Retrieve the associated Contract(s) (via M:1 lookup opportunityid in Contract).
	2. Update those Contracts with some values.
	3. Retrieve the associated Account(s) (via M:1 lookup customerid in Opportunity).
	4. Update that Account with new values.

🔧 Plugin Example
using Microsoft.Xrm.Sdk;
using Microsoft.Xrm.Sdk.Query;
using System;
namespace TestPlugin
{
    public class UpdateContractsAndAccountOnOpportunity : IPlugin
    {
        public void Execute(IServiceProvider serviceProvider)
        {
            ITracingService tracer = (ITracingService)serviceProvider.GetService(typeof(ITracingService));
            IPluginExecutionContext context = (IPluginExecutionContext)serviceProvider.GetService(typeof(IPluginExecutionContext));
            IOrganizationServiceFactory factory = (IOrganizationServiceFactory)serviceProvider.GetService(typeof(IOrganizationServiceFactory));
            IOrganizationService service = factory.CreateOrganizationService(context.UserId);
try
            {
                if (context.InputParameters.Contains("Target") && context.InputParameters["Target"] is Entity)
                {
                    Entity opportunityEntity = (Entity)context.InputParameters["Target"];
if (opportunityEntity.LogicalName == "opportunity")
                    {
                        Guid opportunityId = opportunityEntity.Id;
                        tracer.Trace("Processing Opportunity: " + opportunityId);
// ✅ Step 1: Retrieve all contracts linked to this opportunity
                        QueryExpression contractQuery = new QueryExpression("contract")
                        {
                            ColumnSet = new ColumnSet("contractid", "title", "statuscode")
                        };
                        contractQuery.Criteria.AddCondition("opportunityid", ConditionOperator.Equal, opportunityId);
EntityCollection contracts = service.RetrieveMultiple(contractQuery);
                        tracer.Trace($"Found {contracts.Entities.Count} contract(s) for this opportunity.");
// ✅ Step 2: Update each contract
                        foreach (Entity contract in contracts.Entities)
                        {
                            Entity updateContract = new Entity("contract", contract.Id);
                            updateContract["title"] = (contract.Contains("title") ? contract["title"].ToString() : "") + " - Updated by Plugin";
                            updateContract["statuscode"] = new OptionSetValue(2); // Example: "In Progress"
                            service.Update(updateContract);
tracer.Trace($"Updated Contract: {contract.Id}");
                        }
// ✅ Step 3: Retrieve associated Account (customerid)
                        if (opportunityEntity.Contains("customerid"))
                        {
                            EntityReference accountRef = (EntityReference)opportunityEntity["customerid"];
if (accountRef.LogicalName == "account")
                            {
                                Guid accountId = accountRef.Id;
                                Entity accountToUpdate = new Entity("account", accountId);
// Example updates
                                accountToUpdate["description"] = "Updated from Opportunity plugin at " + DateTime.Now;
                                accountToUpdate["telephone1"] = "999-888-7777";
service.Update(accountToUpdate);
                                tracer.Trace($"Updated Account: {accountId}");
                            }
                        }
                    }
                }
            }
            catch (Exception ex)
            {
                tracer.Trace("UpdateContractsAndAccountOnOpportunity: {0}", ex.ToString());
                throw new InvalidPluginExecutionException("An error occurred in UpdateContractsAndAccountOnOpportunity.", ex);
            }
        }
    }
}

⚡ Key Logic
	• Contracts: Retrieved with QueryExpression filtering opportunityid.
	• Update Contract: Changed title and statuscode.
	• Account: Retrieved directly from opportunity.customerid.
	• Update Account: Changed description and telephone1 (example).

✅ This plugin works if:
	• Contract → Opportunity is M:1 (lookup field opportunityid).
	• Opportunity → Account is M:1 (lookup field customerid).

👉 Do you want me to also add a filter so this only runs when Opportunity status = “Won” (otherwise skip), or should it always run on Opportunity create/update?

From <https://chatgpt.com/c/68c469aa-149c-8327-b23a-d35d969a79ef> 


From <https://chatgpt.com/c/68c469aa-149c-8327-b23a-d35d969a79ef> 


