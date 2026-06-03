require("dotenv").config({ path: "../.env" });

const express = require("express");

const cors = require("cors");

const path = require("path");

const app = express();

app.use(cors());

app.use(express.json());

app.use(express.static(__dirname));

app.get("/", (req, res) => {

    res.sendFile(path.join(__dirname, "index.html"));

});

let cachedMotToken = null;

let motTokenExpiry = 0;

let cachedEbayToken = null;

let ebayTokenExpiry = 0;

function cleanRegistration(registration) {

    return String(registration || "").replace(/\s/g, "").toUpperCase();

}
async function decodeVinWithNhtsa(vin) {

    const cleanVin = String(vin || "").toUpperCase().replace(/\s/g, "");

    if (!cleanVin || cleanVin.length !== 17 || /[IOQ]/.test(cleanVin)) {

        return {

            valid: false,

            error: "VIN should be 17 characters and must not contain I, O or Q"

        };

    }

    const response = await fetch(

        `https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinExtended/${cleanVin}?format=json`

    );

    const data = await response.json();

    const getValue = label => {

        const item = data.Results.find(x => x.Variable === label);

        return item?.Value || "";

    };

    return {

        valid: true,

        vin: cleanVin,

        make: getValue("Make"),

        model: getValue("Model"),

        year: getValue("Model Year"),

        fuel: getValue("Fuel Type - Primary"),

        engine: getValue("Displacement (L)"),

        bodyClass: getValue("Body Class"),

        transmission: getValue("Transmission Style"),

        doors: getValue("Doors"),

        raw: data.Results

    };

}
async function getMotAccessToken() {

    if (cachedMotToken && Date.now() < motTokenExpiry) return cachedMotToken;

    const body = new URLSearchParams({

        grant_type: "client_credentials",

        client_id: process.env.MOT_CLIENT_ID,

        client_secret: process.env.MOT_CLIENT_SECRET,

        scope: process.env.MOT_SCOPE

    });

    const response = await fetch(process.env.MOT_TOKEN_URL, {

        method: "POST",

        headers: { "Content-Type": "application/x-www-form-urlencoded" },

        body

    });

    const data = await response.json();

    if (!response.ok) {

        console.error("MOT token error:", data);

        throw new Error("Failed to get MOT access token");

    }

    cachedMotToken = data.access_token;

    motTokenExpiry = Date.now() + ((data.expires_in || 3600) - 60) * 1000;

    return cachedMotToken;

}

async function getEbayAccessToken() {

    if (cachedEbayToken && Date.now() < ebayTokenExpiry) return cachedEbayToken;

    const credentials = Buffer.from(

        `${process.env.EBAY_CLIENT_ID}:${process.env.EBAY_CLIENT_SECRET}`

    ).toString("base64");

    const response = await fetch("https://api.ebay.com/identity/v1/oauth2/token", {

        method: "POST",

        headers: {

            Authorization: `Basic ${credentials}`,

            "Content-Type": "application/x-www-form-urlencoded"

        },

        body: "grant_type=client_credentials&scope=https://api.ebay.com/oauth/api_scope"

    });

    const data = await response.json();

    if (!response.ok) {

        console.error("eBay token error:", data);

        throw new Error("Failed to get eBay access token");

    }

    cachedEbayToken = data.access_token;

    ebayTokenExpiry = Date.now() + ((data.expires_in || 7200) - 60) * 1000;

    return cachedEbayToken;

}

function normaliseMotData(data) {

    if (Array.isArray(data)) return data[0] || null;

    return data || null;

}

async function getMotHistory(registration) {

    const token = await getMotAccessToken();

    const cleanReg = cleanRegistration(registration);

    const response = await fetch(

        `https://history.mot.api.gov.uk/v1/trade/vehicles/registration/${cleanReg}`,

        {

            method: "GET",

            headers: {

                Authorization: `Bearer ${token}`,

                "X-API-Key": process.env.MOT_API_KEY,

                Accept: "application/json"

            }

        }

    );

    const data = await response.json();

    if (!response.ok) {

        console.error("MOT lookup error:", data);

        return null;

    }

    return normaliseMotData(data);

}

async function getDvlaVehicle(registration) {

    const cleanReg = cleanRegistration(registration);

    const response = await fetch("https://driver-vehicle-licensing.api.gov.uk/vehicle-enquiry/v1/vehicles", {

        method: "POST",

        headers: {

            "x-api-key": process.env.DVLA_API_KEY,

            "Content-Type": "application/json"

        },

        body: JSON.stringify({ registrationNumber: cleanReg })

    });

    const data = await response.json();

    if (!response.ok) {

        console.error("DVLA lookup error:", data);

        return null;

    }

    return data;

}

async function searchEbayVehicles(query) {

    const token = await getEbayAccessToken();

    const params = new URLSearchParams({
        q: query,
        limit: "50",
        category_ids: "9801",
        filter: "buyingOptions:{FIXED_PRICE}"
    });

    const url = `https://api.ebay.com/buy/browse/v1/item_summary/search?${params.toString()}`;

    const response = await fetch(url, {
        method: "GET",
        headers: {
            Authorization: `Bearer ${token}`,
            "X-EBAY-C-MARKETPLACE-ID": "EBAY_GB",
            Accept: "application/json"
        }
    });

    const data = await response.json();

    if (!response.ok) {
        console.error("eBay search error:", data);
        return {
            query,
            totalFromEbay: 0,
            listings: [],
            marketStats: buildMarketStats([]),
            averageAdvertisedPrice: null,
            ebayError: data
        };
    }

    const listings = (data.itemSummaries || []).map(item => ({
        title: item.title,
        price: Number(item.price?.value || 0),
        currency: item.price?.currency || "GBP",
        condition: item.condition || "",
        url: item.itemWebUrl || "",
        image: item.image?.imageUrl || ""
    }));

    const carListings = listings.filter(item =>
        item.price > 1000 &&
        item.price < 100000 &&
        item.currency === "GBP"
    );

    const marketStats = buildMarketStats(carListings);

    return {
        query,
        totalFromEbay: data.total || 0,
        listings: carListings,
        marketStats,
        averageAdvertisedPrice: marketStats.average
    };
}

function buildMarketStats(listings) {
    const prices = (listings || [])
        .map(item => Number(item.price))
        .filter(price => price > 1000 && price < 100000)
        .sort((a, b) => a - b);

    if (!prices.length) {
        return {
            count: 0,
            low: null,
            high: null,
            average: null,
            median: null,
            confidenceScore: 15,
            confidenceLabel: "Low",
            confidenceReason: "No strong eBay comparables found"
        };
    }

    const average = Math.round(prices.reduce((a, b) => a + b, 0) / prices.length);
    const middle = Math.floor(prices.length / 2);
    const median = prices.length % 2
        ? prices[middle]
        : Math.round((prices[middle - 1] + prices[middle]) / 2);

    let confidenceScore = 35;
    if (prices.length >= 10) confidenceScore += 20;
    if (prices.length >= 20) confidenceScore += 20;
    if (prices.length >= 35) confidenceScore += 10;

    const spread = prices[prices.length - 1] - prices[0];
    const spreadPercent = average ? spread / average : 1;
    if (spreadPercent < 0.35) confidenceScore += 15;
    else if (spreadPercent > 0.75) confidenceScore -= 10;

    confidenceScore = Math.max(0, Math.min(100, confidenceScore));

    let confidenceLabel = "Low";
    if (confidenceScore >= 75) confidenceLabel = "High";
    else if (confidenceScore >= 50) confidenceLabel = "Medium";

    return {
        count: prices.length,
        low: prices[0],
        high: prices[prices.length - 1],
        average,
        median,
        confidenceScore,
        confidenceLabel,
        confidenceReason: `${prices.length} comparable advertised eBay listings analysed`
    };
}

function buildAiPricing({ marketStats, adjustedRetailValue, tradeValue, buyScore, desirabilityScore, motAnalysis, estimatedPrepTotal }) {
    const base = marketStats?.median || marketStats?.average || adjustedRetailValue;

    let retail = Number(adjustedRetailValue || base || 0);
    let quickSale = Math.round(retail * 0.96);
    let stretchPrice = Math.round(retail * 1.04);
    let maxBid = Math.round(tradeValue - estimatedPrepTotal);

    const reasons = [];

    if (marketStats?.confidenceLabel === "High") reasons.push("Good number of eBay comparables found, so pricing confidence is higher.");
    if (marketStats?.confidenceLabel === "Medium") reasons.push("Some eBay comparables found, but still check Auto Trader/Facebook manually before buying.");
    if (!marketStats || marketStats.confidenceLabel === "Low") reasons.push("Low comparable count, so treat this as a guide only.");

    if (buyScore >= 75) {
        stretchPrice = Math.round(stretchPrice * 1.01);
        reasons.push("Strong buy score supports pricing near the upper end if condition is genuinely good.");
    }

    if (desirabilityScore < 55) {
        retail = Math.round(retail * 0.98);
        quickSale = Math.round(quickSale * 0.97);
        reasons.push("Lower desirability score suggests pricing aggressively to avoid it sitting in stock.");
    }

    if (motAnalysis?.motRiskLevel === "High") {
        retail = Math.round(retail * 0.97);
        quickSale = Math.round(quickSale * 0.96);
        reasons.push("High MOT risk reduces recommended retail pricing.");
    }

    if (estimatedPrepTotal > 700) {
        maxBid = Math.round(maxBid - 300);
        reasons.push("Higher prep allowance reduces the recommended maximum bid.");
    }

    retail = Math.max(500, Math.round(retail));
    quickSale = Math.max(500, Math.round(quickSale));
    stretchPrice = Math.max(retail, Math.round(stretchPrice));
    maxBid = Math.max(0, Math.round(maxBid));

    return {
        recommendedRetail: retail,
        quickSalePrice: quickSale,
        stretchAdvertisedPrice: stretchPrice,
        maxBidPrice: maxBid,
        confidenceScore: marketStats?.confidenceScore || 15,
        confidenceLabel: marketStats?.confidenceLabel || "Low",
        reasoning: reasons
    };
}



function buildVehicleSpecificCommonProblems({ vehicle, mileage, motAnalysis, notes }) {

    const make = String(vehicle?.make || "").toLowerCase();
    const model = String(vehicle?.model || "").toLowerCase();
    const fuel = String(vehicle?.fuel || "").toLowerCase();
    const engine = String(vehicle?.engine || "").toLowerCase();
    const combined = `${make} ${model} ${fuel} ${engine} ${String(notes || "").toLowerCase()}`;
    const mileageNumber = Number(mileage || 0);
    const problems = [];

    const add = text => {
        if (text && !problems.includes(text)) problems.push(text);
    };

    add("Check for warning lights and scan for stored fault codes before buying.");
    add("Check service history, correct oil grade, and evidence of regular maintenance.");

    if (fuel.includes("hybrid") || fuel.includes("electric") || fuel.includes("phev") || combined.includes("330e") || combined.includes("530e") || combined.includes("prius")) {
        add("Check high-voltage battery health, charging operation, charging cable, and any hybrid/electric drivetrain warnings.");
        add("Check petrol engine cold start as hybrids can hide engine running issues during short tests.");
    }

    if (fuel.includes("diesel")) {
        add("Check DPF regeneration history, soot loading, and signs of blocked DPF from short journeys.");
        add("Check EGR system, turbo boost control, intercooler pipes, and injector correction values.");
        if (mileageNumber > 80000) add("Check dual-mass flywheel/clutch wear or automatic gearbox behaviour at higher mileage.");
    }

    if (fuel.includes("petrol")) {
        add("Check timing belt/chain history, coolant leaks, misfires, coil packs, and oil consumption.");
        if (combined.includes("turbo") || combined.includes("ecoboost") || combined.includes("tsi") || combined.includes("tfsi")) {
            add("Check turbo boost, smoke under load, oil leaks, and boost pipe condition.");
        }
    }

    if (make.includes("ford") && (model.includes("fiesta") || model.includes("focus")) && combined.includes("ecoboost")) {
        add("Ford EcoBoost: confirm wet timing belt/oil pump belt replacement history and check for oil pressure or belt debris issues.");
        add("Ford EcoBoost: check coolant loss, thermostat housing, turbo oil leaks, and rough idle/misfire.");
    }

    if (make.includes("ford") && (model.includes("fiesta") || model.includes("focus")) && combined.includes("automatic")) {
        add("Ford automatic: check Powershift/automatic gearbox engagement, shuddering, delayed drive, and service history.");
    }

    if ((make.includes("bmw") || combined.includes("mini")) && (combined.includes("b47") || fuel.includes("diesel") || model.includes("320d") || model.includes("118d") || model.includes("120d"))) {
        add("BMW diesel: check timing chain noise, EGR/cooler recalls, DPF condition, swirl flaps, and turbo actuator operation.");
    }

    if (make.includes("bmw") && (combined.includes("330e") || combined.includes("530e") || fuel.includes("hybrid"))) {
        add("BMW plug-in hybrid: check charging flap/port, charging cable, hybrid battery warranty, coolant system, and electric drive faults.");
    }

    if (make.includes("audi") || make.includes("volkswagen") || make.includes("seat") || make.includes("skoda")) {
        add("VW/Audi group: check DSG/automatic gearbox service history, mechatronic behaviour, water pump/thermostat leaks, and electrical faults.");
        if (fuel.includes("diesel")) add("VW/Audi diesel: check EGR, DPF, turbo actuator, injector balance, and AdBlue faults if fitted.");
        if (combined.includes("tfsi") || combined.includes("tsi")) add("VW/Audi petrol turbo: check timing chain/belt history, oil consumption, PCV faults, and coolant leaks.");
    }

    if (make.includes("vauxhall") || make.includes("opel")) {
        add("Vauxhall/Opel: check timing chain/belt history, coolant leaks, oil leaks, and gearbox/clutch operation.");
        if (fuel.includes("diesel")) add("Vauxhall diesel: check EGR, DPF, turbo oil leaks, injector seals, and intercooler pipe condition.");
    }

    if (make.includes("peugeot") || make.includes("citroen") || make.includes("ds")) {
        add("Peugeot/Citroen: check wet belt/timing belt history where applicable, AdBlue system, DPF, and electrical faults.");
    }

    if (make.includes("land rover") || make.includes("range rover") || model.includes("discovery")) {
        add("Land Rover: check air suspension, coolant leaks, electrical faults, transfer box/diffs, and full diagnostic scan results.");
        if (fuel.includes("diesel")) add("Land Rover diesel: check timing belts, turbo issues, EGR, DPF, inlet manifolds, and oil leaks.");
    }

    if (make.includes("nissan") && model.includes("qashqai")) {
        add("Nissan Qashqai: check CVT gearbox if automatic, timing chain/belt history, suspension knocks, and electrical faults.");
    }

    if (motAnalysis?.motCategories?.corrosion > 0) add("MOT history shows corrosion: inspect sills, subframes, brake pipes, suspension mounts, and rear axle areas carefully.");
    if (motAnalysis?.motCategories?.tyres > 0) add("MOT history shows tyre advisories: check tyre age, matching brands, alignment wear, and suspension geometry.");
    if (motAnalysis?.motCategories?.brakes > 0) add("MOT history shows brake advisories: check discs, pads, calipers, brake pipes, and handbrake operation.");
    if (motAnalysis?.motCategories?.suspension > 0) add("MOT history shows suspension issues: road test for knocks and check springs, arms, bushes, shocks, and wheel bearings.");
    if (motAnalysis?.motCategories?.emissions > 0) add("MOT history shows emissions issues: check smoke, exhaust leaks, DPF/cat condition, lambda/NOx sensors, and engine running quality.");

    if (mileageNumber > 100000) {
        add("High mileage: check timing history, clutch/gearbox, suspension wear, oil leaks, cooling system, and proof of regular servicing.");
    } else if (mileageNumber < 30000) {
        add("Low mileage: check for long periods unused, perished tyres, brake corrosion, weak battery, and short-journey DPF issues on diesels.");
    }

    return problems.slice(0, 12);

}

function analyseSpec(spec) {

    const lower = (spec || "").toLowerCase();

    const result = { specScore: 0, specValueAdjustment: 0, specNotes: [] };

    const specItems = [

        ["pan roof", 750, 8], ["sun roof", 500, 5], ["harman", 500, 5],

        ["upgraded sound", 400, 4], ["apple carplay", 350, 4], ["android auto", 250, 3],

        ["360 camera", 400, 5], ["reverse camera", 250, 3], ["adaptive cruise", 350, 4],

        ["cruise control", 150, 2], ["blind spot", 300, 4], ["lane assist", 200, 3],

        ["heated front seats", 250, 3], ["heated rear seats", 200, 2],

        ["cooled front seats", 350, 4], ["cooled rear seats", 250, 3],

        ["electric seats", 250, 3], ["memory seats", 300, 4], ["leather seats", 300, 4],

        ["massage seats", 350, 4], ["head up display", 350, 4], ["digital dash", 300, 4],

        ["pro nav", 400, 4], ["matrix led", 350, 4], ["led headlights", 200, 2],

        ["keyless entry", 200, 2], ["keyless start", 150, 2], ["electric tailgate", 250, 3],

        ["wireless charging", 150, 2], ["alloy wheels", 150, 2], ["parking sensors", 150, 2],

        ["electric windows", 50, 1], ["climate control", 150, 2], ["air conditioning", 100, 1],

        ["tow bar", 200, 2]

    ];

    specItems.forEach(([keyword, value, score]) => {

        if (lower.includes(keyword)) {

            result.specValueAdjustment += value;

            result.specScore += score;

            result.specNotes.push(`${keyword}: +£${value}`);

        }

    });

    result.specScore = Math.min(result.specScore, 35);

    return result;

}

function analyseMotHistory(motData) {

    const result = {

        motRiskScore: 0,

        motRiskLevel: "Low",

        motRiskNotes: [],

        mileageAnomalies: [],

        motCategories: {

            corrosion: 0,

            tyres: 0,

            brakes: 0,

            suspension: 0,

            lights: 0,

            emissions: 0,

            generalNeglect: 0

        },

        likelyRetailSpeedScore: 70,

        likelyRetailSpeed: "Average"

    };

    if (!motData || !motData.motTests || motData.motTests.length === 0) {

        result.motRiskScore = 40;

        result.motRiskLevel = "Unknown";

        result.motRiskNotes.push("No MOT history found");

        result.likelyRetailSpeedScore -= 10;

        return result;

    }

    const tests = motData.motTests;

    let failCount = 0;

    let advisoryCount = 0;

    tests.forEach(test => {

        if (test.testResult === "FAILED") {

            failCount++;

            result.motRiskScore += 8;

        }

        if (test.defects && test.defects.length > 0) {

            test.defects.forEach(defect => {

                const text = (defect.text || "").toLowerCase();

                const type = (defect.type || "").toLowerCase();

                if (type.includes("advisory")) advisoryCount++;

                if (text.includes("corrosion") || text.includes("rust")) {

                    result.motCategories.corrosion++;

                    result.motRiskScore += 10;

                }

                if (text.includes("tyre") || text.includes("tread")) {

                    result.motCategories.tyres++;

                    result.motRiskScore += 3;

                }

                if (text.includes("brake") || text.includes("disc") || text.includes("pad")) {

                    result.motCategories.brakes++;

                    result.motRiskScore += 4;

                }

                if (text.includes("suspension") || text.includes("spring") || text.includes("shock") || text.includes("bush")) {

                    result.motCategories.suspension++;

                    result.motRiskScore += 5;

                }

                if (text.includes("lamp") || text.includes("light") || text.includes("headlamp")) {

                    result.motCategories.lights++;

                    result.motRiskScore += 2;

                }

                if (text.includes("emission") || text.includes("smoke")) {

                    result.motCategories.emissions++;

                    result.motRiskScore += 8;

                }

            });

        }

    });

    if (failCount >= 3) {

        result.motRiskNotes.push("Multiple MOT failures recorded");

        result.likelyRetailSpeedScore -= 10;

    }

    if (advisoryCount >= 8) {

        result.motRiskNotes.push("High number of advisories");

        result.likelyRetailSpeedScore -= 8;

    }

    if (result.motCategories.corrosion > 0) {

        result.motRiskNotes.push("Corrosion history found");

        result.likelyRetailSpeedScore -= 15;

    }

    if (result.motCategories.tyres >= 3) {

        result.motRiskNotes.push("Repeated tyre advisories suggest maintenance neglect");

        result.likelyRetailSpeedScore -= 5;

    }

    if (result.motCategories.brakes >= 3) {

        result.motRiskNotes.push("Repeated brake wear advisories");

        result.likelyRetailSpeedScore -= 5;

    }

    for (let i = 0; i < tests.length - 1; i++) {

        const newer = Number(tests[i].odometerValue || 0);

        const older = Number(tests[i + 1].odometerValue || 0);

        if (newer && older && newer < older) {

            result.mileageAnomalies.push(`Possible mileage discrepancy: ${newer} miles recorded after ${older} miles`);

            result.motRiskScore += 25;

            result.likelyRetailSpeedScore -= 25;

        }

    }

    if (result.mileageAnomalies.length === 0) {

        result.motRiskNotes.push("No mileage anomalies detected");

    }

    result.motRiskScore = Math.max(0, Math.min(100, result.motRiskScore));

    result.likelyRetailSpeedScore = Math.max(0, Math.min(100, result.likelyRetailSpeedScore));

    if (result.motRiskScore >= 65) result.motRiskLevel = "High";

    else if (result.motRiskScore >= 35) result.motRiskLevel = "Medium";

    else result.motRiskLevel = "Low";

    if (result.likelyRetailSpeedScore >= 80) result.likelyRetailSpeed = "Fast seller";

    else if (result.likelyRetailSpeedScore >= 60) result.likelyRetailSpeed = "Average seller";

    else if (result.likelyRetailSpeedScore >= 40) result.likelyRetailSpeed = "Slow seller";

    else result.likelyRetailSpeed = "Hard to retail";

    return result;

}

function basicVinDecode(vin) {

    if (!vin) return { vinProvided: false, validFormat: false, message: "No VIN entered" };

    const cleanVin = vin.toUpperCase().replace(/\s/g, "");

    return {

        vinProvided: true,

        vin: cleanVin,

        validFormat: cleanVin.length === 17 && !/[IOQ]/.test(cleanVin),

        message: cleanVin.length === 17 && !/[IOQ]/.test(cleanVin)

            ? "VIN format looks valid. Full VIN decoding will need DVLA or a VIN decoder API."

            : "VIN should normally be 17 characters and should not contain I, O or Q."

    };

}

function gradeVehicle({ condition, motAnalysis, buyScore, desirabilityScore }) {

    let score = 70;

    if (condition === "excellent") score += 15;

    if (condition === "good") score += 5;

    if (condition === "average") score -= 10;

    if (condition === "poor") score -= 25;

    if (motAnalysis?.motRiskLevel === "Low") score += 10;

    if (motAnalysis?.motRiskLevel === "Medium") score -= 10;

    if (motAnalysis?.motRiskLevel === "High") score -= 25;

    if (motAnalysis?.mileageAnomalies?.length > 0) score -= 25;

    score += Math.round((buyScore - 70) / 3);

    score += Math.round((desirabilityScore - 70) / 4);

    score = Math.max(0, Math.min(100, score));

    if (score >= 85) return { gradeScore: score, grade: "A", summary: "Strong retail car. Good stock candidate." };

    if (score >= 70) return { gradeScore: score, grade: "B", summary: "Good retail car with manageable risk." };

    if (score >= 50) return { gradeScore: score, grade: "C", summary: "Retail with caution. Check prep costs carefully." };

    if (score >= 35) return { gradeScore: score, grade: "D", summary: "High-risk retail car. Only buy cheap." };

    return { gradeScore: score, grade: "Trade only", summary: "Avoid retail unless bought extremely cheaply." };

}

function buildNegotiationHelper({ motAnalysis, specAnalysis, motLength, condition, prepCosts, mileage }) {

    const points = [];

    if (condition === "poor") points.push("Use poor overall condition to negotiate strongly.");

    if (condition === "average") points.push("Use average condition to justify a reduced offer.");

    if (motLength === "short") points.push("Short MOT gives negotiation leverage.");

    if (motLength === "none") points.push("No MOT is a major negotiation point.");

    if (motAnalysis?.motRiskLevel === "High") points.push("High MOT risk suggests a strong price reduction is needed.");

    if (motAnalysis?.motCategories?.corrosion > 0) points.push("Corrosion history is strong leverage. Consider reducing offer significantly.");

    if (motAnalysis?.motCategories?.tyres >= 2) points.push("Repeated tyre advisories suggest maintenance neglect.");

    if (motAnalysis?.motCategories?.brakes >= 2) points.push("Brake advisories can justify a prep cost deduction.");

    if (motAnalysis?.mileageAnomalies?.length > 0) points.push("Mileage anomaly detected. Proceed very carefully or avoid.");

    if (Number(mileage) > 100000) points.push("High mileage should reduce the offer unless condition and history are excellent.");

    if (specAnalysis?.specValueAdjustment > 500) points.push("Good spec helps resale, but do not overpay for spec alone.");

    if (prepCosts?.length > 0) {

        points.push(`Use estimated prep costs of £${prepCosts.reduce((a, b) => a + b.cost, 0)} during negotiation.`);

    }

    if (points.length === 0) {

        points.push("No major negotiation weaknesses found. Focus on market price and margin.");

    }

    return points;

}

app.get("/api/mot/:registration", async (req, res) => {

    try {

        const motData = await getMotHistory(req.params.registration);

        res.json(motData);

    } catch (err) {

        res.status(500).json({ error: "MOT lookup failed", details: err.message });

    }

});

app.get("/api/dvla/:registration", async (req, res) => {

    try {

        const dvlaData = await getDvlaVehicle(req.params.registration);

        res.json(dvlaData);

    } catch (err) {

        res.status(500).json({ error: "DVLA lookup failed", details: err.message });

    }

});
app.get("/api/vin/:vin", async (req, res) => {

    try {

        const vinData = await decodeVinWithNhtsa(req.params.vin);

        res.json(vinData);

    } catch (err) {

        res.status(500).json({

            error: "VIN decode failed",

            details: err.message

        });

    }

});
app.get("/api/ebay-search", async (req, res) => {

    try {

        const query = req.query.q || "";

        const ebayData = await searchEbayVehicles(query);

        res.json(ebayData);

    } catch (err) {

        res.status(500).json({ error: "eBay search failed", details: err.message });

    }

});

app.post("/vehicle", async (req, res) => {

    try {

        const {

            registration,

            vin,

            mileage,

            condition,

            spec,

            serviceHistory,

            bodywork,

            tyres,

            alloys,

            interior,

            warningLights,

            keys,

            v5,

            motLength,

            owners,

            gearbox,

            clutch,

            notes

        } = req.body;

        const motData = registration ? await getMotHistory(registration) : null;

        const dvlaData = registration ? await getDvlaVehicle(registration) : null;

        const motAnalysis = analyseMotHistory(motData);

        const specAnalysis = analyseSpec(spec);

        const vinDecode = basicVinDecode(vin);

        const vehicle = {

            make: dvlaData?.make || motData?.make || "Unknown",

            model: motData?.model || "Unknown",

            year: dvlaData?.yearOfManufacture || (motData?.firstUsedDate ? new Date(motData.firstUsedDate).getFullYear() : "Unknown"),

            fuel: dvlaData?.fuelType || motData?.fuelType || "Unknown",

            colour: dvlaData?.colour || motData?.primaryColour || "Unknown",

            engine: dvlaData?.engineCapacity ? `${dvlaData.engineCapacity}cc` : "Unknown",

            taxStatus: dvlaData?.taxStatus || "Unknown",

            motStatus: dvlaData?.motStatus || "Unknown",

            co2Emissions: dvlaData?.co2Emissions || "Unknown"

        };

       const ebayQuery =

`${vehicle.make} ${vehicle.model} ${vehicle.year} ${vehicle.fuel} ${spec || ""}`;

const ebayData = await searchEbayVehicles(ebayQuery);

// Filter similar mileage vehicles

const mileageTolerance = 20000;

const filteredListings = ebayData.listings.filter(item => {

    const title = (item.title || "").toLowerCase();

    const mileageMatch =

        title.match(/(\d{1,3}[, ]?\d{3})\s*miles/i) ||

        title.match(/(\d{1,3}[, ]?\d{3})\s*mi/i);

    if (!mileageMatch) return true;

    const listingMileage =

        parseInt(mileageMatch[1].replace(/[,\s]/g, ""));

    return Math.abs(listingMileage - Number(mileage || 0))

        <= mileageTolerance;

});

const marketListings = filteredListings;

const marketStats = buildMarketStats(filteredListings);

let marketAverage = marketStats.median || marketStats.average || ebayData.averageAdvertisedPrice || 10000;
        

    


        let adjustments = [];

        let prepCosts = [];

        let desirabilityScore = 70;

        let buyScore = 70;

        marketAverage += specAnalysis.specValueAdjustment;

        desirabilityScore += specAnalysis.specScore;

        buyScore += Math.round(specAnalysis.specScore / 2);

        if (specAnalysis.specValueAdjustment > 0) {

            adjustments.push(`Desirable spec adjustment: +£${specAnalysis.specValueAdjustment}`);

        }

        const mileageNumber = Number(mileage || 0);

        const ownersNumber = Number(owners || 0);

        const mileageDeduction = Math.round(mileageNumber * 0.02);

        marketAverage -= mileageDeduction;

        adjustments.push(`Mileage adjustment: -£${mileageDeduction}`);

        if (motAnalysis.motRiskLevel === "Medium") {

            marketAverage -= 350;

            desirabilityScore -= 6;

            buyScore -= 8;

            prepCosts.push({ item: "MOT risk allowance", cost: 250 });

            adjustments.push("Medium MOT risk: -£350");

        }

        if (motAnalysis.motRiskLevel === "High") {

            marketAverage -= 900;

            desirabilityScore -= 15;

            buyScore -= 20;

            prepCosts.push({ item: "High MOT risk allowance", cost: 700 });

            adjustments.push("High MOT risk: -£900");

        }

        if (motAnalysis.mileageAnomalies.length > 0) {

            marketAverage -= 1200;

            desirabilityScore -= 25;

            buyScore -= 30;

            adjustments.push("Mileage anomaly detected: -£1200");

        }

        if (motAnalysis.motCategories.corrosion > 0) {

            marketAverage -= 750;

            desirabilityScore -= 12;

            buyScore -= 15;

            prepCosts.push({ item: "Corrosion risk allowance", cost: 600 });

            adjustments.push("Corrosion history found: -£750");

        }

        if (condition === "poor") {

            marketAverage -= 1500;

            desirabilityScore -= 15;

            buyScore -= 18;

            prepCosts.push({ item: "General reconditioning", cost: 800 });

            adjustments.push("Poor overall condition: -£1500");

        }

        if (condition === "average") {

            marketAverage -= 750;

            desirabilityScore -= 6;

            buyScore -= 8;

            prepCosts.push({ item: "General preparation", cost: 350 });

            adjustments.push("Average overall condition: -£750");

        }

        if (condition === "excellent") {

            marketAverage += 1000;

            desirabilityScore += 10;

            buyScore += 10;

            adjustments.push("Excellent overall condition: +£1000");

        }

        if (serviceHistory === "full") {

            marketAverage += 500;

            desirabilityScore += 8;

            buyScore += 8;

            adjustments.push("Full service history: +£500");

        }

        if (serviceHistory === "partial") {

            marketAverage -= 250;

            desirabilityScore -= 4;

            buyScore -= 4;

            adjustments.push("Partial service history: -£250");

        }

        if (serviceHistory === "none") {

            marketAverage -= 750;

            desirabilityScore -= 12;

            buyScore -= 12;

            prepCosts.push({ item: "Service due / history risk", cost: 250 });

            adjustments.push("No service history: -£750");

        }

        if (bodywork === "poor") {

            marketAverage -= 1000;

            desirabilityScore -= 12;

            buyScore -= 14;

            prepCosts.push({ item: "Bodywork repairs", cost: 800 });

            adjustments.push("Poor bodywork: -£1000");

        }

        if (bodywork === "average") {

            marketAverage -= 400;

            desirabilityScore -= 5;

            buyScore -= 5;

            prepCosts.push({ item: "Minor bodywork", cost: 300 });

            adjustments.push("Average bodywork: -£400");

        }

        if (tyres === "poor") {

            marketAverage -= 400;

            desirabilityScore -= 5;

            buyScore -= 6;

            prepCosts.push({ item: "Tyres", cost: 350 });

            adjustments.push("Poor tyres: -£400");

        }

        if (alloys === "poor") {

            marketAverage -= 350;

            desirabilityScore -= 4;

            buyScore -= 4;

            prepCosts.push({ item: "Alloy refurbishment", cost: 300 });

            adjustments.push("Poor alloys: -£350");

        }

        if (interior === "poor") {

            marketAverage -= 600;

            desirabilityScore -= 8;

            buyScore -= 8;

            prepCosts.push({ item: "Interior clean/repair", cost: 250 });

            adjustments.push("Poor interior: -£600");

        }

        if (warningLights === "yes") {

            marketAverage -= 1000;

            desirabilityScore -= 15;

            buyScore -= 20;

            prepCosts.push({ item: "Diagnostic/repair allowance", cost: 700 });

            adjustments.push("Warning lights present: -£1000");

        }

        if (keys === "one") {

            marketAverage -= 250;

            desirabilityScore -= 3;

            buyScore -= 3;

            prepCosts.push({ item: "Spare key", cost: 220 });

            adjustments.push("Only one key: -£250");

        }

        if (v5 === "no") {

            marketAverage -= 500;

            desirabilityScore -= 8;

            buyScore -= 10;

            adjustments.push("No V5 present: -£500");

        }

        if (motLength === "short") {

            marketAverage -= 500;

            desirabilityScore -= 6;

            buyScore -= 8;

            prepCosts.push({ item: "MOT/pre-MOT allowance", cost: 250 });

            adjustments.push("Short MOT: -£500");

        }

        if (motLength === "none") {

            marketAverage -= 900;

            desirabilityScore -= 12;

            buyScore -= 18;

            prepCosts.push({ item: "MOT and repair allowance", cost: 600 });

            adjustments.push("No MOT: -£900");

        }

        if (ownersNumber >= 5) {

            marketAverage -= 500;

            desirabilityScore -= 7;

            buyScore -= 7;

            adjustments.push("High number of owners: -£500");

        }

        if (gearbox === "issue") {

            marketAverage -= 1500;

            desirabilityScore -= 18;

            buyScore -= 25;

            prepCosts.push({ item: "Gearbox issue allowance", cost: 1200 });

            adjustments.push("Gearbox issue: -£1500");

        }

        if (clutch === "issue") {

            marketAverage -= 800;

            desirabilityScore -= 10;

            buyScore -= 15;

            prepCosts.push({ item: "Clutch issue allowance", cost: 650 });

            adjustments.push("Clutch issue: -£800");

        }

        if (mileageNumber > 100000) {

            desirabilityScore -= 10;

            buyScore -= 8;

        }

        if (mileageNumber < 50000) {

            desirabilityScore += 8;

            buyScore += 6;

        }

        desirabilityScore += Math.round((motAnalysis.likelyRetailSpeedScore - 70) / 5);

        buyScore += Math.round((motAnalysis.likelyRetailSpeedScore - 70) / 5);

        marketAverage = Math.round(Math.max(500, marketAverage));

        desirabilityScore = Math.max(0, Math.min(100, desirabilityScore));

        buyScore = Math.max(0, Math.min(100, buyScore));

        const estimatedPrepTotal = prepCosts.reduce((a, b) => a + b.cost, 0);

        const retailValue = marketAverage;

        const tradeValue = Math.round(retailValue * 0.88);

        const aiPricing = buildAiPricing({
            marketStats,
            adjustedRetailValue: retailValue,
            tradeValue,
            buyScore,
            desirabilityScore,
            motAnalysis,
            estimatedPrepTotal
        });

        let buyAdvice = "Proceed with caution.";

        if (buyScore >= 80) buyAdvice = "Strong buy if the purchase price leaves enough margin.";

        else if (buyScore >= 65) buyAdvice = "Possible buy. Check prep costs and negotiate hard.";

        else if (buyScore >= 45) buyAdvice = "Risky buy. Only consider if it is very cheap.";

        else buyAdvice = "Avoid unless buying well below trade value.";

        const vehicleGrade = gradeVehicle({

            condition,

            motAnalysis,

            buyScore,

            desirabilityScore

        });

        const negotiationHelper = buildNegotiationHelper({

            motAnalysis,

            specAnalysis,

            motLength,

            condition,

            prepCosts,

            mileage

        });

        const commonProblems = buildVehicleSpecificCommonProblems({

            vehicle,

            mileage,

            motAnalysis,

            notes

        });

        res.json({

            vehicle,

            registration,

            dvlaData,

            ebayData,

            marketListings,

            marketStats,

            aiPricing,

            marketAverage,

            retailValue,

            tradeValue,

            adjustments,

            prepCosts,

            estimatedPrepTotal,

            desirabilityScore,

            buyScore,

            buyAdvice,

            commonProblems,

            notes,

            motData,

            motAnalysis,

            specAnalysis,

            vehicleGrade,

            negotiationHelper,

            vinDecode

        });

    } catch (err) {

        console.log(err);

        res.status(500).json({ error: "Server error", details: err.message });

    }

});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {

    console.log(`Server running on port ${PORT}`);

});
