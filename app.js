var q = require('q');
var _ = require('lodash');
var request = require('request');
var elasticsearch = require('elasticsearch');
var client = new elasticsearch.Client();

// Local caches of recipes and pricing data.
var recipes = {};
var prices = {};

// Methods.
var getPrices, getRecipes, traverseRecipe, checkProfitable, renderRecipe, rounded;

// Constants.
var LISTING_FEE = 0.95;
var SALES_TAX = 0.9;

/**
 * Repeat a string {count} times.
 */
String.prototype.repeat = function (count) {
  if (count < 1) { return ''; }
  var result = '', pattern = this.valueOf();
  while (count > 1) {
    if (count & 1) { result += pattern; }
    count >>= 1, pattern += pattern;
  }
  return result + pattern;
};

/**
 * Capitalize the first character of a string.
 */
String.prototype.capitalize = function() {
  return this.charAt(0).toUpperCase() + this.slice(1);
};

/**
 * Round a float to two decimal places.
 */
rounded = function (num) {
  var sign = num >= 0 ? 1 : -1;
  return (Math.round((num * Math.pow(10, 2)) + (sign  *0.001)) / Math.pow(10, 2)).toFixed(2);
};

/**
 * Retrieve all pricing data from gw2tp.com.
 */
getPrices = function () {
  var deferred = q.defer();
  request({
      url: 'http://api.gw2tp.com/1/bulk/items.json',
      json: true
  }, function (error, response, body) {
    _.forEach(body.items, function (item) {
      item = _.zipObject(body.columns, item);
      prices[item.id] = { buy: item.buy, sell: item.sell };
    });
    deferred.resolve();
  });
  return deferred.promise;
};

/**
 * Retrieve all indexed recipes.
 */
getRecipes = function () {
  var deferred = q.defer();
  client.search({
    index: 'gw2',
    type: 'recipe',
    size: 9000
  }).then(function (results) {
    _.forEach(results.hits.hits, function (hit) { recipes[hit._id] = hit._source; });
    client.close();
    deferred.resolve();
  });
  return deferred.promise;
};

/**
 * Traverse a recipe, calculating crafting prices.
 */
traverseRecipe = function (recipe) {
  if (!recipe || recipe.output_item.hasOwnProperty('acquisition')) { return; }
  recipe.output_item.prices = prices[recipe.output_item_id] || {};

  recipe.noSellPrice = false;
  recipe.hasAccountBound = false;
  recipe.learnedFromItem = _.indexOf(recipe.flags, 'LearnedFromItem') >= 0;

  if (!recipe.output_item.prices.hasOwnProperty('sell') || recipe.output_item.prices.sell === 0)  {
    recipe.noSellPrice = true;
    return;
  }

  if (recipe.ingredients.length) {
    var craftedTotal = 0;
    _.forEach(recipe.ingredients, function (ingredient) {
      // Traverse ingredients with recipes, or assign prices to raw ingredients
      if (ingredient.recipe_id && recipes[ingredient.recipe_id]) {
        var ingredientRecipe = recipes[ingredient.recipe_id];
        traverseRecipe(ingredientRecipe);
        if (ingredientRecipe.noSellPrice) { recipe.noSellPrice = true; return; }
        if (ingredientRecipe.hasAccountBound) { recipe.hasAccountBound = true; }
        if (ingredientRecipe.learnedFromItem) { recipe.learnedFromItem = true; }
        ingredient.item.prices = ingredientRecipe.output_item.prices;
      } else {
        if (_.indexOf(ingredient.item.flags, 'AccountBound') === -1) {
          ingredient.item.prices = prices[ingredient.item_id] || {};
          ingredient.item.acquisition = 'buy';
          if (!ingredient.item.prices.hasOwnProperty('sell') || ingredient.item.prices.sell === 0) {
            recipe.noSellPrice = true;
          }
        } else {
          recipe.hasAccountBound = true;
          ingredient.item.prices = {};
        }
      }

      // Add crafted or sell price to the craftedTotal
      if (!recipe.noSellPrice && ingredient.item.prices.sell) {
        if (ingredient.item.prices.crafted) {
          craftedTotal += ingredient.item.prices.crafted * ingredient.count;
        } else {
          craftedTotal += ingredient.item.prices.sell * ingredient.count;
        }
      }
    });

    // Compare the combined price of the ingredients with the sell price
    if (!recipe.noSellPrice) {
      craftedTotal = craftedTotal / recipe.output_item_count;
      recipe.output_item.prices.crafted = craftedTotal;
      if (craftedTotal < recipe.output_item.prices.sell) {
        recipe.output_item.acquisition = 'craft';
      } else {
        recipe.output_item.acquisition = 'buy';
      }
    }
  } else {
    // No ingredients, so buying is the only option
    recipe.output_item.acquisition = 'buy';
  }
  return true;
};

/**
 * Check to see if a traversed recipe is profitable when crafted vs. highest buy order.
 */
checkProfitable = function (recipe) {
  var itemName = recipe.output_item.name;
  var acquiredBy = recipe.output_item.acquisition;
  if (recipe.learnedFromItem) {
    return false;
  }
  if (recipe.noSellPrice) {
    return false;
  }
  if (recipe.hasAccountBound) {
    return false;
  }
  if (!acquiredBy) {
    return false;
  }
  var prices = recipe.output_item.prices;
  if (!prices.buy) {
    return false;
  } else if (!prices.sell) {
    return false;
  } else if (acquiredBy !== 'craft') {
    return false;
  }
  var craftedPrice = prices && prices.crafted;
  if (!craftedPrice) {
    return false;
  }
  var listingFee = prices.buy - (prices.buy * LISTING_FEE);
  var profitAfterTax = prices.buy * SALES_TAX;
  var spread = profitAfterTax - listingFee - craftedPrice;
  if (spread > 1000) {
    console.log(recipe.disciplines, recipe.min_rating);
    return spread;
  }

  return false;
};

/**
 * Render a recipe to the console.
 */
renderRecipe = function (recipe, count, level) {
  count = count || 1;
  level = level || 0;
  level && process.stdout.write('\n');
  process.stdout.write('  '.repeat(level));

  var name = recipe.output_item.name;
  var pricing = recipe.output_item.prices;
  var from = '???';
  var each = '???';

  if (pricing && pricing.sell) {
    if (pricing.crafted && pricing.crafted < pricing.sell) {
      from = 'craft';
      each = rounded(pricing.crafted / 100);
    } else {
      from = 'buy';
      each = rounded(pricing.sell / 100);
    }
  }

  process.stdout.write(name +' x '+ count +' ('+ from +' for '+ each +' each)');
  if (recipe.ingredients && recipe.ingredients.length) {
    level++;
    _.forEach(recipe.ingredients, function (ingredient) {
      var ingredientRecipe = ingredient.recipe_id ?
        recipes[ingredient.recipe_id] : { output_item: ingredient.item };
      renderRecipe(ingredientRecipe, ingredient.count, level);
    });
  }
};

//=========================================================================//

// 1. Get all indexed recipes
getRecipes()

  // 2. Get pricing data
  .then(getPrices)

    // 3. Loop through recipes
    .then(function () {
      var profitable = 0;
      _.forEach(recipes, function (recipe) {

        // 4. Traverse the top–level recipe
        traverseRecipe(recipe);

        // 5. Check to see if the recipe is profitable
        var profit = checkProfitable(recipe);
        if (profit) {
          profitable++;
          renderRecipe(recipe);
          console.log('\n[Profit = '+ rounded(profit/100) +'s]\n');
        }
      });
      console.log(profitable +' profitable recipes found!');
    });

//=========================================================================//

/*
TODO:
  - hard–code list of prices for vendor items
  - handle items with no pricing data: what should happen?
 */
