var q = require('q');
var _ = require('lodash');
var request = require('request');
var elasticsearch = require('elasticsearch');
var client = new elasticsearch.Client();
var express = require('express');
var app = express();

// Local caches of recipes and pricing data.
var recipes = {};
var prices = {};

// Methods.
var getPrices, getRecipes, traverseRecipe, checkProfitable;

// Constants.
var LISTING_FEE = 0.95;
var SALES_TAX = 0.9;

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
      prices[item.id] = item;
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
        ingredient.recipe = ingredientRecipe;
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
        if (ingredient.item.prices.crafted && ingredient.item.prices.crafted < ingredient.item.prices.sell) {
          craftedTotal += ingredient.item.prices.crafted * ingredient.count;
          ingredient.item.acquisition = 'craft';
        } else {
          craftedTotal += ingredient.item.prices.sell * ingredient.count;
          ingredient.item.acquisition = 'buy';
        }
      }
    });

    // Compare the combined price of the ingredients with the sell price
    if (!recipe.noSellPrice) {
      craftedTotal = craftedTotal / recipe.output_item_count;
      recipe.output_item.prices.crafted = craftedTotal;
      recipe.output_item.acquisition = (craftedTotal < recipe.output_item.prices.sell) ? 'craft' : 'buy';
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
  var prices = recipe.output_item.prices;
  var craftedPrice = prices && prices.crafted;
  var acquiredBy = recipe.output_item.acquisition;

  var redFlags = [
    recipe.learnedFromItem,
    recipe.noSellPrice,
    recipe.hasAccountBound,
    !acquiredBy,
    !prices.buy,
    !prices.sell,
    !craftedPrice,
    acquiredBy !== 'craft'
  ];

  if (_.compact(redFlags).length) { return false; }

  var listingFee = prices.buy - (prices.buy * LISTING_FEE);
  var profitAfterTax = prices.buy * SALES_TAX;
  recipe.output_item.spread = profitAfterTax - listingFee - craftedPrice;
  return (recipe.output_item.spread > 100) ? recipe.output_item.spread : false;
};

//=========================================================================//

app.all('*', function (req, res, next) {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'X-Requested-With');
  next();
 });

// Get all indexed recipes
getRecipes()

  // Start the express server
  .then(function () {
    var server = app.listen(3000, function () {
      console.log('Listening on port %d', server.address().port);
    });
  });

//=========================================================================//

app.get('/profits.json', function (req, res) {
  
  // Get pricing data
  getPrices()

    // Loop through recipes
    .then(function () {
      var profitable = [];
      _.forEach(recipes, function (recipe) {
        try {
          // Traverse the top–level recipe
          traverseRecipe(recipe);

          // Check to see if the recipe is profitable
          if (checkProfitable(recipe)) { profitable.push(recipe); }
        }
        catch (e) {
          console.log('caught', e);
        }
      });

      // Output profitable recipes as JSON
      profitable = _.sortBy(profitable, function (recipe) { return recipe.output_item.spread; }).reverse();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write(JSON.stringify({ recipes: profitable }));
      res.end();
    });
});

//=========================================================================//
